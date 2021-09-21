// SPDX-License-Identifier: MIT
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "./ProtocolTypes.sol";
import "./libraries/TimeSlot.sol";
import "./libraries/AddressPacking.sol";
import "./libraries/BokkyPooBahsDateTimeLibrary.sol";

/**
 * @title Payment Aggregator contract is used to aggregate payments  
 * between counterparties in bilateral relationships. Those payments 
 * are defined per counterparties addresses (packed into one bytes32), 
 * main settlement currency and payment date. 
 *
 * Contract linked to all product based contracts like Loan, Swap, etc.
 */
contract PaymentAggregator is ProtocolTypes {
    using SafeMath for uint256;
    using Address for address;
    using TimeSlot for TimeSlot.Slot;
    using EnumerableSet for EnumerableSet.AddressSet;

    event RegisterPayment(address indexed party0, address indexed party1, bytes32 ccy, bytes32 timeSlot, uint256 payment0, uint256 payment1);
    event VerifyPayment(address indexed party0, address indexed party1, bytes32 ccy, bytes32 timeSlot, uint256 payment, bytes32 txHash);
    event SettlePayment(address indexed party0, address indexed party1, bytes32 ccy, bytes32 timeSlot, uint256 payment, bytes32 txHash);
    event RemovePayment(address indexed party0, address indexed party1, bytes32 ccy, bytes32 timeSlot, uint256 payment0, uint256 payment1);

    address public owner;
    uint256 constant MAXPAYNUM = 5;

    // Linked contract addresses
    EnumerableSet.AddressSet private paymentAggregatorUsers;

    // Mapping structure for storing TimeSlots
    mapping(bytes32 => mapping(bytes32 => mapping (bytes32 => TimeSlot.Slot))) _timeSlots;

    /** 
     * @dev Array with number of days per term
    */
    uint256[MAXPAYNUM] sched_3m = [90 days];
    uint256[MAXPAYNUM] sched_6m = [180 days];
    uint256[MAXPAYNUM] sched_1y = [365 days];
    uint256[MAXPAYNUM] sched_2y = [365 days, 730 days];
    uint256[MAXPAYNUM] sched_3y = [365 days, 730 days, 1095 days];
    uint256[MAXPAYNUM] sched_5y = [
        365 days,
        730 days,
        1095 days,
        1460 days,
        1825 days
    ];

    /** 
     * @dev Number of days conversion table per term
    */
    uint256[][NUMTERM] DAYS = [
        sched_3m,
        sched_6m,
        sched_1y,
        sched_2y,
        sched_3y,
        sched_5y
    ];

    /** 
     * @dev Number of payments conversion table to determine number of TimeSlots per term
    */
    uint256[NUMTERM] PAYNUMS = [
        1,
        1,
        1,
        2,
        3,
        5
    ];

    /** 
     * @dev Day count fractions for interest rate calculations per term
    */
    uint256[NUMTERM] DCFRAC = [
        2500,
        5000,
        BP,
        BP,
        BP,
        BP
    ];

    /**
    * @dev Modifier to make a function callable only by contract owner.
    */
    modifier onlyOwner() {
        require(msg.sender == owner);
        _;
    }

    /**
    * @dev Modifier to check if msg.sender is payment aggregator user
    */
    modifier acceptedContract() {
        require(paymentAggregatorUsers.contains(msg.sender), "not allowed to use payment aggregator");
        _;
    }

    /**
    * @dev Contract constructor function.
    *
    * @notice sets contract deployer as owner of this contract
    */
    constructor() public {
        owner = msg.sender;
    }

    /**
    * @dev Trigers to add contract address to payment aggregator users address set
    * @param _user Payment aggregator user smart contract address
    *
    * @notice Trigers only be contract owner
    * @notice Reverts on saving 0x0 address
    */
    function addPaymentAggregatorUser(address _user) public onlyOwner returns (bool) {
        require(_user != address(0), "Zero address");
        require(_user.isContract(), "Can't add non-contract address");
        require(!paymentAggregatorUsers.contains(_user), "Can't add existing address");
        return paymentAggregatorUsers.add(_user);
    }

    /**
    * @dev Trigers to remove payment aggregator user from address set
    * @param _user Payment aggregator user smart contract address
    *
    * @notice Trigers only be contract owner
    * @notice Reverts on removing non-existing payment aggregator user
    */
    function removePaymentAggregatorUser(address _user) public onlyOwner returns (bool) {
        require(paymentAggregatorUsers.contains(_user), "Can't remove non-existing user");
        return paymentAggregatorUsers.remove(_user);
    }

    /**
    * @dev Trigers to check if provided `addr` is a payment aggregator user from address set
    * @param _user Contract address to check if it's a payment aggregator user
    *
    */
    function isPaymentAggregatorUser(address _user) public view returns (bool) {
        return paymentAggregatorUsers.contains(_user);
    }

    struct TimeSlotPaymentsLocalVars {
        bytes32 packedAddrs;
        bool flipped;
        uint256 time;
        uint256 payNums;
        uint256 lastPayNum;
        uint256 coupon0;
        uint256 coupon1;
        uint256 repayment0;
        uint256 repayment1;
        bytes32 slotPosition;
    }

    /**
    * @dev Triggered to construct payment schedule for new loan deal.
    * @param party0 First counterparty address
    * @param party1 Second counterparty address
    * @param ccy Main settlement currency in a deal
    * @param term Product deal term
    * @param notional Notional amount of funds in product
    * @param rate0 Product interest rate for first party
    * @param rate1 Product interest rate for second party
    * @param repayment Boolean to identify if repayment should be included
    */
    function registerPayments(
        address party0,
        address party1,
        bytes32 ccy,
        Term term,
        uint256 notional,
        uint256 rate0,
        uint256 rate1,
        bool repayment
    ) external acceptedContract {
        TimeSlotPaymentsLocalVars memory vars;

        vars.payNums = PAYNUMS[uint256(term)];
        vars.lastPayNum = vars.payNums.sub(1);
        vars.time = block.timestamp;
        uint256[] memory daysArr = DAYS[uint256(term)];
        (vars.packedAddrs, vars.flipped) = AddressPacking.pack(party0, party1);

        if (rate0 > 0) {
            vars.coupon0 = (notional.mul(rate0).mul(DCFRAC[uint256(term)])).div(BP).div(BP);
        } 

        if (rate1 > 0) {
            vars.coupon1 = (notional.mul(rate1).mul(DCFRAC[uint256(term)])).div(BP).div(BP);
        }

        for (uint256 i = 0; i < vars.payNums; i++) {
            (vars.time, vars.slotPosition) = _slotPositionPlusDays(vars.time, daysArr[i]);

            if (i == vars.lastPayNum && repayment) {
                vars.repayment0 = notional.add(vars.coupon0);
                vars.repayment1 = notional.add(vars.coupon1);

                if (vars.flipped) {
                    TimeSlot.addPayment(_timeSlots, vars.packedAddrs, ccy, vars.slotPosition, vars.repayment1, vars.repayment0);
                } else {
                    TimeSlot.addPayment(_timeSlots, vars.packedAddrs, ccy, vars.slotPosition, vars.repayment0, vars.repayment1);
                }
            } else {
                if (vars.flipped) {
                    TimeSlot.addPayment(_timeSlots, vars.packedAddrs, ccy, vars.slotPosition, vars.coupon1, vars.coupon0);
                } else {
                    TimeSlot.addPayment(_timeSlots, vars.packedAddrs, ccy, vars.slotPosition, vars.coupon0, vars.coupon1);
                }
            }
        }
    }

    /**
    * @dev External function to verify payment by msg.sender, uses timestamp to identify TimeSlot.
    * @param counterparty Counterparty address
    * @param ccy Main payment settlement currency
    * @param timestamp Main timestamp for TimeSlot
    * @param payment Main payment settlement currency
    * @param txHash Main payment settlement currency
    */
    function verifyPayment(
        address counterparty,
        bytes32 ccy,
        uint256 timestamp,
        uint256 payment,
        bytes32 txHash
    ) external {
        (bytes32 packedAddrs, ) = AddressPacking.pack(msg.sender, counterparty);
        (uint256 year, uint256 month, uint256 day) = BokkyPooBahsDateTimeLibrary.timestampToDate(timestamp);
        bytes32 slotPosition = TimeSlot.position(year, month, day);

        TimeSlot.verifyPayment(_timeSlots, packedAddrs, ccy, slotPosition, payment, txHash);
    }

    /**
    * @dev External function to verify payment by msg.sender, uses direct TimeSlot position.
    * @param counterparty Counterparty address
    * @param ccy Main payment settlement currency
    * @param slot TimeSlot position
    * @param payment Main payment settlement currency
    * @param txHash Main payment settlement currency
    */
    function verifyPayment(
        address counterparty,
        bytes32 ccy,
        bytes32 slot,
        uint256 payment,
        bytes32 txHash
    ) external {
        (bytes32 packedAddrs, ) = AddressPacking.pack(msg.sender, counterparty);
        TimeSlot.verifyPayment(_timeSlots, packedAddrs, ccy, slot, payment, txHash);
    }

    /**
    * @dev External function to settle payment using timestamp to identify TimeSlot.
    * @param counterparty Counterparty address
    * @param ccy Main payment settlement currency
    * @param timestamp Main timestamp for TimeSlot
    * @param payment Main payment settlement currency
    * @param txHash Main payment settlement currency
    */
    function settlePayment(
        address counterparty,
        bytes32 ccy,
        uint256 timestamp,
        uint256 payment,
        bytes32 txHash
    ) external {
        (bytes32 packedAddrs, ) = AddressPacking.pack(msg.sender, counterparty);
        (uint256 year, uint256 month, uint256 day) = BokkyPooBahsDateTimeLibrary.timestampToDate(timestamp);
        bytes32 slotPosition = TimeSlot.position(year, month, day);

        TimeSlot.settlePayment(_timeSlots, packedAddrs, ccy, slotPosition, payment, txHash);
    }

    /**
    * @dev External function to settle payment using direct TimeSlot position.
    * @param counterparty Counterparty address
    * @param ccy Main payment settlement currency
    * @param slot TimeSlot position
    * @param payment Main payment settlement currency
    * @param txHash Main payment settlement currency
    */
    function settlePayment(
        address counterparty,
        bytes32 ccy,
        bytes32 slot,
        uint256 payment,
        bytes32 txHash
    ) external {
        (bytes32 packedAddrs, ) = AddressPacking.pack(msg.sender, counterparty);
        TimeSlot.settlePayment(_timeSlots, packedAddrs, ccy, slot, payment, txHash);
    }

    /**
    * @dev External function to remove payments while liquidating a deal.
    * @param party0 First counterparty address
    * @param party1 Second counterparty address
    * @param ccy Main settlement currency in a deal
    * @param startDate Product registration time
    * @param term Product deal term
    * @param notional Notional amount of funds in product
    * @param rate0 Product interest rate for first party
    * @param rate1 Product interest rate for second party
    * @param repayment Boolean to identify if repayment should be included
    */
    function removePayments(
        address party0,
        address party1,
        bytes32 ccy,
        uint256 startDate,
        Term term,
        uint256 notional,
        uint256 rate0,
        uint256 rate1,
        bool repayment
    ) external acceptedContract {
        TimeSlotPaymentsLocalVars memory vars;

        vars.payNums = PAYNUMS[uint256(term)];
        vars.lastPayNum = vars.payNums.sub(1);
        vars.time = startDate;
        uint256[] memory daysArr = DAYS[uint256(term)];
        (vars.packedAddrs, vars.flipped) = AddressPacking.pack(party0, party1);

        if (rate0 > 0) {
            vars.coupon0 = (notional.mul(rate0).mul(DCFRAC[uint256(term)])).div(BP).div(BP);
        } 

        if (rate1 > 0) {
            vars.coupon1 = (notional.mul(rate1).mul(DCFRAC[uint256(term)])).div(BP).div(BP);
        }

        for (uint256 i = 0; i < vars.payNums; i++) {
            (vars.time, vars.slotPosition) = _slotPositionPlusDays(vars.time, daysArr[i]);

            if (i == vars.lastPayNum && repayment) {
                vars.repayment0 = notional.add(vars.coupon0);
                vars.repayment1 = notional.add(vars.coupon1);

                if (vars.flipped) {
                    TimeSlot.removePayment(_timeSlots, vars.packedAddrs, ccy, vars.slotPosition, vars.repayment1, vars.repayment0);
                } else {
                    TimeSlot.removePayment(_timeSlots, vars.packedAddrs, ccy, vars.slotPosition, vars.repayment0, vars.repayment1);
                }
            } else {
                if (vars.flipped) {
                    TimeSlot.removePayment(_timeSlots, vars.packedAddrs, ccy, vars.slotPosition, vars.coupon1, vars.coupon0);
                } else {
                    TimeSlot.removePayment(_timeSlots, vars.packedAddrs, ccy, vars.slotPosition, vars.coupon0, vars.coupon1);
                }
            }
        }
    }

    /**
    * @dev Internal function to get TimeSlot position after adding days
    * @param timestamp Timestamp to add days
    * @param numDays number of days to add
    * @return Updated timestamp and TimeSlot position
    */
    function _slotPositionPlusDays(uint256 timestamp, uint256 numDays) internal pure returns (uint256, bytes32) {
        timestamp = BokkyPooBahsDateTimeLibrary.addDays(timestamp, numDays);
        (uint256 year, uint256 month, uint256 day) = BokkyPooBahsDateTimeLibrary.timestampToDate(timestamp);
        bytes32 slotPosition = TimeSlot.position(year, month, day);

        return (timestamp, slotPosition);
    }

}