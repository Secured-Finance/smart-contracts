// SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/ICollateralVault.sol";
import "./libraries/SafeTransfer.sol";
import "./libraries/CollateralPosition.sol";
import "./mixins/MixinAddressResolver.sol";

/**
 * @title CollateralVault is the main implementation contract for storing and keeping user's collateral
 *
 * This contract allows users to deposit and withdraw their funds to fulfill
 * their collateral obligations against different trades.
 *
 * CollateralVault is working with ETH or ERC20 token with specified on deployment `tokenAddress`.
 *
 * CollateralAggregator uses independent Collateral vaults for rebalancing collateral
 * between global books and bilateral positions, and liquidating collateral while performing
 * single or multi-deal liquidation.
 *
 */
contract CollateralVault is ICollateralVault, MixinAddressResolver, Ownable, SafeTransfer {
    using SafeMath for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;
    using CollateralPosition for CollateralPosition.Position;

    struct Book {
        uint256 independentAmount;
        uint256 lockedCollateral;
    }

    address public override tokenAddress;
    bytes32 public override ccy;

    // Mapping for all deposits of users collateral
    mapping(address => Book) private books;

    // Mapping for bilateral collateral positions between 2 counterparties.
    mapping(bytes32 => CollateralPosition.Position) private _positions;

    /**
     * @dev Modifier to check if user registered on collateral aggregator
     */
    modifier onlyRegisteredUser() {
        require(collateralAggregator().checkRegisteredUser(msg.sender), "NON_REGISTERED_USER");
        _;
    }

    /**
     * @dev Contract constructor function.
     *
     * @notice sets contract deployer as owner of this contract and links
     * with collateral aggregator and currency controller contracts
     */
    constructor(
        address _resolver,
        bytes32 _ccy,
        address _tokenAddress,
        address _WETH9
    ) MixinAddressResolver(_resolver) SafeTransfer(_WETH9) {
        tokenAddress = _tokenAddress;
        ccy = _ccy;

        buildCache();

        require(currencyController().isCollateral(_ccy), "COLLATERAL_ASSET_NOT_SUPPORTED");
    }

    function requiredContracts() public pure override returns (bytes32[] memory contracts) {
        contracts = new bytes32[](2);
        contracts[0] = CONTRACT_COLLATERAL_AGGREGATOR;
        contracts[1] = CONTRACT_CURRENCY_CONTROLLER;
    }

    function acceptedContracts() public pure override returns (bytes32[] memory contracts) {
        contracts = new bytes32[](1);
        contracts[0] = CONTRACT_COLLATERAL_AGGREGATOR;
    }

    /**
     * @dev Trigers to deposit funds by the msg.sender into collateral book
     * @param _amount Number of funds to deposit
     */
    function deposit(uint256 _amount) public payable override onlyRegisteredUser {
        require(_amount > 0, "INVALID_AMOUNT");
        _depositAssets(tokenAddress, msg.sender, address(this), _amount);

        Book storage book = books[msg.sender];
        book.independentAmount = book.independentAmount.add(_amount);

        _afterTransfer();

        emit Deposit(msg.sender, _amount);
    }

    /**
     * @dev Deposit collateral funds into bilateral position against counterparty
     * @param _counterparty Counterparty address in bilateral position
     * @notice payable function increases locked collateral by msg.value
     */
    function deposit(address _counterparty, uint256 _amount) public override onlyRegisteredUser {
        require(_amount > 0, "INVALID_AMOUNT");
        _depositAssets(tokenAddress, msg.sender, address(this), _amount);

        CollateralPosition.deposit(_positions, msg.sender, _counterparty, _amount);

        Book storage book = books[msg.sender];
        book.lockedCollateral = book.lockedCollateral.add(_amount);

        _afterTransfer(_counterparty);

        emit PositionDeposit(msg.sender, _counterparty, _amount);
    }

    struct RebalanceLocalVars {
        int256 exchangeRate;
        uint256 target;
        uint256 rebalanceAmount;
        uint256 left;
    }

    /**
     * @dev Rebalances collateral from user's book to bilateral position,
     * as it's executed by collateral aggregator function returns the
     * amount of ETH left to rebalance for other collateral vaults
     *
     * @param _user Main user address to rebalance collateral from
     * @param _counterparty Counterparty address in bilateral position
     * @param _amountETH Amount of funds in ETH required to rebalance
     *
     * @return Amount of funds in ETH left to rebalance for other vault
     */
    function rebalanceTo(
        address _user,
        address _counterparty,
        uint256 _amountETH
    ) external override onlyAcceptedContracts returns (uint256) {
        RebalanceLocalVars memory vars;
        vars.exchangeRate = currencyController().getLastETHPrice(ccy);
        vars.target = _amountETH.mul(1e18).div(uint256(vars.exchangeRate));

        Book storage book = books[_user];
        vars.rebalanceAmount = book.independentAmount >= vars.target
            ? vars.target
            : book.independentAmount;

        if (vars.rebalanceAmount > 0) {
            book.independentAmount = book.independentAmount.sub(vars.rebalanceAmount);
            book.lockedCollateral = book.lockedCollateral.add(vars.rebalanceAmount);

            CollateralPosition.deposit(_positions, _user, _counterparty, vars.rebalanceAmount);
            _afterTransfer(_user, _counterparty);

            emit RebalanceTo(_user, _counterparty, vars.rebalanceAmount);
        }

        vars.left = vars.target.sub(vars.rebalanceAmount);

        return vars.left.mul(uint256(vars.exchangeRate)).div(1e18);
    }

    /**
     * @dev Rebalances collateral from bilateral position to user's book,
     * as it's executed by collateral aggregator function returns the
     * amount of ETH left to rebalance for other collateral vaults
     *
     * @param _user Main user address to rebalance collateral from
     * @param _counterparty Counterparty address in bilateral position
     * @param _amountETH Amount of funds in ETH required to rebalance
     *
     * @return Amount of funds in ETH left to rebalance for other vault
     */
    function rebalanceFrom(
        address _user,
        address _counterparty,
        uint256 _amountETH
    ) external override onlyAcceptedContracts returns (uint256) {
        RebalanceLocalVars memory vars;

        vars.exchangeRate = currencyController().getLastETHPrice(ccy);
        vars.target = _amountETH.mul(1e18).div(uint256(vars.exchangeRate));
        vars.rebalanceAmount = CollateralPosition.withdraw(
            _positions,
            _user,
            _counterparty,
            vars.target
        );

        if (vars.rebalanceAmount > 0) {
            Book storage book = books[_user];
            book.lockedCollateral = book.lockedCollateral.sub(vars.rebalanceAmount);
            book.independentAmount = book.independentAmount.add(vars.rebalanceAmount);

            _afterTransfer(_user, _counterparty);

            emit RebalanceFrom(_user, _counterparty, vars.rebalanceAmount);
        }

        vars.left = vars.target.sub(vars.rebalanceAmount);

        return vars.left.mul(uint256(vars.exchangeRate)).div(1e18);
    }

    /**
     * @dev Rebalances collateral between 2 different bilateral positions,
     * as it's executed by collateral aggregator function returns the
     * amount of ETH left to rebalance for other collateral vaults
     *
     * @param _user Main user address to rebalance collateral from
     * @param _fromParty Counterparty address to rebalance from
     * @param _toParty Counterparty address to rebalance to
     * @param _amountETH Amount of funds in ETH required to rebalance
     *
     * @return Amount of funds in ETH left to rebalance for other vault
     */
    function rebalanceBetween(
        address _user,
        address _fromParty,
        address _toParty,
        uint256 _amountETH
    ) external override onlyAcceptedContracts returns (uint256) {
        RebalanceLocalVars memory vars;

        vars.exchangeRate = currencyController().getLastETHPrice(ccy);
        vars.target = _amountETH.mul(1e18).div(uint256(vars.exchangeRate));
        vars.rebalanceAmount = CollateralPosition.rebalance(
            _positions,
            _user,
            _fromParty,
            _toParty,
            vars.target
        );
        vars.left = vars.target.sub(vars.rebalanceAmount);

        _afterTransfer(_user, _fromParty);
        _afterTransfer(_user, _toParty);

        emit RebalanceBetween(_user, _fromParty, _toParty, vars.rebalanceAmount);

        return vars.left.mul(uint256(vars.exchangeRate)).div(1e18);
    }

    /**
     * @dev Liquidates collateral from bilateral position between parties
     * returns the amount of ETH to be liquidated in other vault
     * if all available funds have been liquidated here
     *
     * @param _from Address for liquidating collateral from
     * @param _to Address for sending collateral to
     * @param _amountETH Liquidation amount in ETH
     *
     * @notice Trigers only be Loan contract
     */
    function liquidate(
        address _from,
        address _to,
        uint256 _amountETH
    ) external override onlyAcceptedContracts returns (uint256 liquidationLeftETH) {
        int256 exchangeRate = currencyController().getLastETHPrice(ccy);
        uint256 liquidationTarget = _amountETH.mul(1e18).div(uint256(exchangeRate));
        uint256 liquidated = CollateralPosition.liquidate(
            _positions,
            _from,
            _to,
            liquidationTarget
        );

        Book storage book = books[_from];
        book.lockedCollateral = book.lockedCollateral.sub(liquidated);

        book = books[_to];
        book.lockedCollateral = book.lockedCollateral.add(liquidated);

        if (liquidated > 0) {
            _afterTransfer(_from, _to);
            emit Liquidate(_from, _to, liquidated);
        }

        uint256 liquidationLeft = liquidationTarget.sub(liquidated);

        if (liquidationLeft > 0) {
            uint256 independentLiquidation = _tryLiquidateIndependentCollateral(
                _from,
                _to,
                liquidationLeft
            );
            liquidationLeft = liquidationLeft.sub(independentLiquidation);
        }

        liquidationLeftETH = liquidationLeft.mul(uint256(exchangeRate)).div(1e18);
    }

    function _tryLiquidateIndependentCollateral(
        address _from,
        address _to,
        uint256 _amount
    ) internal returns (uint256 liquidated) {
        uint256 maxWidthdrawETH = collateralAggregator().getMaxCollateralBookWidthdraw(_from);
        uint256 maxLiquidation = currencyController().convertFromETH(ccy, maxWidthdrawETH);

        liquidated = _amount > maxLiquidation ? maxLiquidation : _amount;

        Book storage book = books[_from];
        book.independentAmount = book.independentAmount.sub(liquidated);

        book = books[_to];
        book.lockedCollateral = book.lockedCollateral.add(liquidated);

        CollateralPosition.deposit(_positions, _to, _from, liquidated);

        emit LiquidateIndependent(_from, _to, liquidated);
    }

    /**
     * @notice Trigers to withdraw funds by the msg.sender from non-locked funds
     * @param _amount Number of funds to withdraw.
     */
    function withdraw(uint256 _amount) public override onlyRegisteredUser {
        // fix according to collateral aggregator
        require(_amount > 0, "INVALID_AMOUNT");

        address user = msg.sender;
        uint256 maxWidthdrawETH = collateralAggregator().getMaxCollateralBookWidthdraw(user);
        uint256 maxWidthdraw = currencyController().convertFromETH(ccy, maxWidthdrawETH);
        uint256 withdrawAmt = _amount > maxWidthdraw ? maxWidthdraw : _amount;

        Book storage book = books[user];
        book.independentAmount = book.independentAmount.sub(withdrawAmt);

        _withdrawAssets(tokenAddress, msg.sender, withdrawAmt);
        _afterTransfer();

        emit Withdraw(msg.sender, withdrawAmt);
    }

    /**
     * @notice Trigers to withdraw funds from bilateral position between
     * msg.sender and _counterparty
     *
     * @param _counterparty Counterparty address.
     * @param _amount Number of funds to withdraw.
     */
    function withdrawFrom(address _counterparty, uint256 _amount)
        public
        override
        onlyRegisteredUser
    {
        require(_amount > 0, "INVALID_AMOUNT");
        address user = msg.sender;

        (uint256 maxWidthdrawETH, ) = collateralAggregator().getMaxCollateralWidthdraw(
            user,
            _counterparty
        );
        uint256 maxWidthdraw = currencyController().convertFromETH(ccy, maxWidthdrawETH);

        uint256 targetWithdraw = _amount > maxWidthdraw ? maxWidthdraw : _amount;
        uint256 withdrawn = CollateralPosition.withdraw(
            _positions,
            user,
            _counterparty,
            targetWithdraw
        );

        Book storage book = books[user];
        book.lockedCollateral = book.lockedCollateral.sub(withdrawn);

        _withdrawAssets(tokenAddress, msg.sender, withdrawn);
        _afterTransfer(_counterparty);

        emit PositionWithdraw(user, _counterparty, withdrawn);
    }

    /**
     * @notice Returns independent collateral from `_user` collateral book
     *
     * @param _user Address of collateral user
     */
    function getIndependentCollateral(address _user) public view override returns (uint256) {
        return books[_user].independentAmount;
    }

    /**
     * @notice Returns independent collateral from `_user` collateral book converted to ETH
     *
     * @param _user Address of collateral user
     */
    function getIndependentCollateralInETH(address _user) public view override returns (uint256) {
        uint256 amount = books[_user].independentAmount;

        return currencyController().convertToETH(ccy, amount);
    }

    /**
     * @notice Returns locked collateral by `_user` in collateral book
     *
     * @param _user Address of collateral user
     */
    function getLockedCollateral(address _user) public view override returns (uint256) {
        return books[_user].lockedCollateral;
    }

    /**
     * @notice Returns locked collateral by `_user` in collateral book converted to ETH
     *
     * @param _user Address of collateral user
     */
    function getLockedCollateralInETH(address _user) public view override returns (uint256) {
        uint256 amount = books[_user].lockedCollateral;

        return currencyController().convertToETH(ccy, amount);
    }

    /**
     * @notice Returns locked collateral by counterparties
     * in a bilateral position in native `ccy`
     *
     * @param _partyA First counterparty address
     * @param _partyB Second counterparty address.
     */
    function getLockedCollateral(address _partyA, address _partyB)
        public
        view
        override
        returns (uint256, uint256)
    {
        return CollateralPosition.get(_positions, _partyA, _partyB);
    }

    /**
     * @notice Returns locked collateral by counterparties
     * in a bilateral position converted to ETH
     *
     * @param _partyA First counterparty address
     * @param _partyB Second counterparty address.
     */
    function getLockedCollateralInETH(address _partyA, address _partyB)
        public
        view
        override
        returns (uint256, uint256)
    {
        (uint256 lockedA, uint256 lockedB) = CollateralPosition.get(_positions, _partyA, _partyB);

        uint256[] memory ethAmounts = new uint256[](2);
        ethAmounts[0] = lockedA;
        ethAmounts[1] = lockedB;

        ethAmounts = currencyController().convertBulkToETH(ccy, ethAmounts);

        return (ethAmounts[0], ethAmounts[1]);
    }

    function _afterTransfer() internal {
        if (books[msg.sender].independentAmount > 0 || books[msg.sender].lockedCollateral > 0) {
            collateralAggregator().enterVault(msg.sender);
        } else {
            collateralAggregator().exitVault(msg.sender);
        }
    }

    function _afterTransfer(address _counterparty) internal {
        _afterTransfer(msg.sender, _counterparty);
    }

    function _afterTransfer(address _user, address _counterparty) internal {
        (uint256 locked0, uint256 locked1) = CollateralPosition.get(
            _positions,
            _user,
            _counterparty
        );

        if (locked0 > 0) {
            collateralAggregator().enterVault(_user);
        }

        if (locked1 > 0) {
            collateralAggregator().enterVault(_counterparty);
        }

        if (locked0 > 0 || locked1 > 0) {
            collateralAggregator().enterVault(_user, _counterparty);
        } else {
            collateralAggregator().exitVault(_user, _counterparty);
        }
    }
}
