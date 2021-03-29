// SPDX-License-Identifier: MIT
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import './interfaces/ICollateral.sol';
import './interfaces/ILoan.sol';
import "./libraries/HitchensOrderStatisticsTreeLib.sol";
import "./ProtocolTypes.sol";

/**
 * @dev Lending Market contract module which allows lending market participants
 * to create/take/cancel market orders.
 *
 * It will store market orders in structured red-black tree and doubly linked list in each node.
 */
contract LendingMarket is ProtocolTypes, ReentrancyGuard {
    using SafeMath for uint256;
    using HitchensOrderStatisticsTreeLib for HitchensOrderStatisticsTreeLib.Tree;

    // Contracts interfaces
    ICollateral collateral;
    ILoan loan;

    /**
    * @dev Emitted when market order created by market maker.
    */
    event MakeOrder(uint256 orderId, address indexed maker, Side side, Ccy ccy, Term term, uint amount, uint rate, uint deadline);
    
    /**
    * @dev Emitted when market order canceled by market maker.
    *
    * Requirements:
    *
    * - Market order must be active and cancelable.
    */
    event CancelOrder(uint256 orderId, address indexed maker, Side side, uint256 amount, uint256 rate);

    /**
    * @dev Emitted when market order taken by market taker.
    *
    * Requirements:
    *
    * - Market order must be active.
    */
    event TakeOrder(uint256 orderId, address indexed taker, Side side, uint256 amount, uint256 rate);

    uint256 public last_order_id;
    Ccy public MarketCcy;
    Term public MarketTerm;
    address public owner;

    struct MarketOrder {
        Side side;
        uint256 amount;
        uint256 rate; // in basis points
        uint256 deadline;
        address maker;
    }

    /**
    * @dev Order Book mapping for all Market Orders.
    */
    mapping (uint256 => MarketOrder) public orders;
    HitchensOrderStatisticsTreeLib.Tree lendOrders;
    HitchensOrderStatisticsTreeLib.Tree borrowOrders;

    /**
    * @dev Constructor.
    * @param _ccy The main currency for order book lending deals
    * @param _term The main term for order book lending deals
    */
    constructor(Ccy _ccy, Term _term, address _owner) public {
        MarketCcy = _ccy;
        MarketTerm = _term;
        owner = _owner;
    }

    /**
    * @dev Modifier to make a function callable only by contract owner.
    */
    modifier onlyOwner() {
        require(msg.sender == owner);
        _;
    }

    /**
    * @dev Modifier to make a function callable only when the market order is active.
    * @param orderId Market order id
    */
    modifier activeOrder(uint256 orderId) {
        if (!isActive(orderId)) {
            require(cancelOrder(orderId), "Couldn't cancel order");
        } else {
            _;
        }
    }

    /**
    * @dev Modifier to make a function callable only when the market order can be canceled by market maker.
    * @param orderId Market order id
    */
    modifier cancelable(uint256 orderId) {
        if (isActive(orderId)) {
            require(getMaker(orderId) == msg.sender, "No access to cancel order");
        }
        _;
    }

    /**
    * @dev Triggers to make a set collateral contract address.
    * @param colAddr Collateral contract addreess
    *
    * Requirements:
    *
    * - Can be executed only by contract owner.
    */
    function setCollateral(address colAddr) public onlyOwner {
        collateral = ICollateral(colAddr);
    }

    /**
    * @dev Triggers to make a set loan contract address.
    * @param addr Loan smart contract addreess
    *
    * Requirements:
    *
    * - Can be executed only by contract owner.
    */
    function setLoan(address addr) public onlyOwner {
        loan = ILoan(addr);
    }

    /**
    * @dev Triggers to make a check if market order executable.
    * If market order exceeded the deadline, market order deleted from order book.
    * @param orderId Market order id
    */
    function isActive(uint256 orderId) public view returns (bool active) {
        return orders[orderId].deadline > block.timestamp;
    }

    /**
    * @dev Triggers to get order maker address.
    * @param orderId Market order id
    */
    function getMaker(uint256 orderId) public view returns (address maker) {
        return orders[orderId].maker;
    }

    /**
    * @dev Triggers to get highest borrow rate.
    */
    function getBorrowRate() public view returns (uint256 rate) {
        return borrowOrders.last();
    }

    /**
    * @dev Triggers to get highest lend rate.
    */
    function getLendRate() public view returns (uint256 rate) {
        return lendOrders.last();
    }

    /**
    * @dev Triggers to get mid rate.
    */
    function getMidRate() public view returns (uint256 rate) {
        uint256 borrowRate = getBorrowRate();
        uint256 lendRate = getLendRate();
        return (borrowRate.add(lendRate)).div(2);
    }

    /**
    * @dev Triggers to get market order information.
    * @param orderId Market order id
    */
    function getOrder(uint256 orderId) public view returns (MarketOrder memory) {
      return orders[orderId];
    }

    function getOrderFromTree(Side side, uint256 rate, uint256 orderId) public view returns (uint256, uint256, uint256, uint256, uint256) {
        if (side == Side.LEND) {
            return lendOrders.getOrderById(rate, orderId);
        } else {
            return borrowOrders.getOrderById(rate, orderId);
        }
    }

    /**
    * @dev Internally triggered to increase and return id of last order in order book.
    */
    function _next_id() internal returns (uint256) {
        last_order_id++; 
        return last_order_id;
    }

    /**
    * @dev Triggered to cancel market order.
    * @param orderId Market order id
    *
    * Requirements:
    * - Order has to be cancelable by market maker
    */
    function cancelOrder(uint256 orderId) public cancelable(orderId) returns (bool success) {
        MarketOrder memory order = orders[orderId];
        if (order.side == Side.LEND) {
            lendOrders.remove(order.amount, order.rate, orderId);
        } else if (order.side == Side.BORROW) {
            borrowOrders.remove(order.amount, order.rate, orderId);
        }
        delete orders[orderId];

        collateral.releaseCollateral(uint8(MarketCcy), order.amount.mul(MKTMAKELEVEL).div(PCT), order.maker);
        emit CancelOrder(
            orderId,
            order.maker,
            order.side,
            order.amount,
            order.rate
        );

        success = true;
    }

    /**
    * @dev Triggered to make new market order.
    * @param _side Borrow or Lend order position
    * @param _amount Amount of funds maker wish to borrow/lend
    * @param _rate Preferable interest rate
    * @param _deadline Deadline for market maker execution (adds to current network timestamp)
    */
    function makeOrder(Side _side, uint256 _amount, uint256 _rate, uint256 _deadline) internal returns (uint256 orderId) {
        MarketOrder memory order;

        require(_amount > 0, "Can't place empty amount");
        require(_rate > 0, "Can't place empty rate");

        order.side = _side;
        order.amount = _amount;
        order.rate = _rate;
        order.maker = msg.sender;
        order.deadline = block.timestamp.add(_deadline);
        orderId = _next_id();

        orders[orderId] = order;
        collateral.useCollateral(uint8(MarketCcy), _amount.mul(MKTMAKELEVEL).div(PCT), msg.sender);
        if (order.side == Side.LEND) {
            lendOrders.insert(order.amount, order.rate, orderId);
        } else if (order.side == Side.BORROW) {
            borrowOrders.insert(order.amount, order.rate, orderId);
        }

        emit MakeOrder(
            orderId, 
            order.maker, 
            order.side, 
            MarketCcy, 
            MarketTerm, 
            order.amount, 
            order.rate, 
            order.deadline    
        );
    }

    /**
    * @dev Triggered to take market order.
    * @param orderId Market Order id in Order Book
    * @param _amount Amount of funds taker wish to borrow/lend
    *
    * Requirements:
    * - Market order has to be active
    */
    function takeOrder(Side side, uint256 orderId, uint256 _amount) internal activeOrder(orderId) returns (bool) {
        MarketOrder memory order = orders[orderId];
        require(_amount <= order.amount, "Insuficient amount");
        require(order.maker != msg.sender, "Maker couldn't take its order");

        orders[orderId].amount = order.amount.sub(_amount);
        if (order.side == Side.LEND) {
            require(lendOrders.fillOrder(order.rate, orderId, _amount), "Couldn't fill order");
        } else if (order.side == Side.BORROW) {
            require(borrowOrders.fillOrder(order.rate, orderId, _amount), "Couldn't fill order");
        }

        loan.makeLoanDeal(order.maker, msg.sender, uint8(order.side), uint8(MarketCcy), uint8(MarketTerm), _amount, order.rate);

        emit TakeOrder(
            orderId,
            msg.sender,
            side,
            _amount,
            order.rate
        );

        if (order.amount == 0) {
            delete orders[orderId];
        }

        return true;
    }

    /**
    * @dev Triggered to get matching market order.
    * @param side Market order side it can be borrow or lend
    * @param amount Amount of funds taker wish to borrow/lend
    * @param rate Amount of interest rate taker wish to borrow/lend
    *
    * Returns zero if didn't find a matched order, reverts if no orders for specified interest rate
    */
    function matchOrders(Side side, uint256 amount, uint256 rate) public view returns (uint256) {
        if (side == Side.LEND) {
            require(borrowOrders.exists(rate), "No orders exists for selected interest rate");
            return borrowOrders.findOrderIdForAmount(rate, amount);
        } else {
            require(lendOrders.exists(rate), "No orders exists for selected interest rate");
            return lendOrders.findOrderIdForAmount(rate, amount);
        }
    }

    /**
    * @dev Triggered to execute market order, if order matched it takes order, if not matched places new order.
    * @param side Market order side it can be borrow or lend
    * @param amount Amount of funds maker/taker wish to borrow/lend
    * @param rate Amount of interest rate maker/taker wish to borrow/lend
    * @param deadline Deadline for market maker execution (adds to current network timestamp)
    *
    * Returns true after successful execution
    */
    function order(Side side, uint256 amount, uint256 rate, uint256 deadline) public nonReentrant returns (bool) {
        uint256 orderId;

        if (side == Side.LEND) {
            orderId = borrowOrders.findOrderIdForAmount(rate, amount);
            if (orderId != 0) return takeOrder(Side.BORROW, orderId, amount);
        } else {
            orderId = lendOrders.findOrderIdForAmount(rate, amount);
            if (orderId != 0) return takeOrder(Side.LEND, orderId, amount);
        }

        makeOrder(side, amount, rate, deadline);
        return true;
    }
}