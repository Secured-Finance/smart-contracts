// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./interfaces/ICollateralVault.sol";
import "./libraries/SafeTransfer.sol";
import "./libraries/CollateralPosition.sol";
import "./mixins/MixinAddressResolver.sol";
import "./utils/Ownable.sol";
import "./utils/Proxyable.sol";
import {CollateralVaultStorage as Storage} from "./storages/CollateralVaultStorage.sol";

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
contract CollateralVault is
    ICollateralVault,
    MixinAddressResolver,
    Ownable,
    SafeTransfer,
    Proxyable
{
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /**
     * @dev Modifier to check if user registered on collateral aggregator
     */
    modifier onlyRegisteredUser() {
        require(collateralAggregator().checkRegisteredUser(msg.sender), "User not registered");
        _;
    }

    /**
     * @notice Initializes the contract.
     * @dev Function is invoked by the proxy contract when the contract is added to the ProxyController
     */
    function initialize(
        address owner,
        address resolver,
        address WETH9
    ) public initializer onlyProxy {
        _transferOwnership(owner);
        _registerToken(WETH9);
        registerAddressResolver(resolver);
    }

    function requiredContracts() public pure override returns (bytes32[] memory contracts) {
        contracts = new bytes32[](2);
        contracts[0] = Contracts.COLLATERAL_AGGREGATOR;
        contracts[1] = Contracts.CURRENCY_CONTROLLER;
    }

    function acceptedContracts() public pure override returns (bytes32[] memory contracts) {
        contracts = new bytes32[](1);
        contracts[0] = Contracts.COLLATERAL_AGGREGATOR;
    }

    function registerCurrency(bytes32 _ccy, address _tokenAddress) external onlyOwner {
        require(currencyController().isCollateral(_ccy), "Invalid currency");
        Storage.slot().tokenAddresses[_ccy] = _tokenAddress;
    }

    /**
     * @dev Deposit funds by the msg.sender into collateral book
     * @param _amount Number of funds to deposit
     * @param _ccy Specified currency
     */
    function deposit(bytes32 _ccy, uint256 _amount) public payable override onlyRegisteredUser {
        require(Storage.slot().tokenAddresses[_ccy] != address(0), "Invalid currency");
        require(_amount > 0, "Invalid amount");
        _depositAssets(Storage.slot().tokenAddresses[_ccy], msg.sender, address(this), _amount);

        Storage.Book storage book = Storage.slot().books[msg.sender][_ccy];
        book.independentAmount = book.independentAmount + _amount;

        _updateUsedCurrencies(_ccy);

        emit Deposit(msg.sender, _ccy, _amount);
    }

    /**
     * @dev Deposit collateral funds into bilateral position against counterparty
     * @param _counterparty Counterparty address in bilateral position
     * @param _ccy Specified currency
     * @param _amount Number of funds to deposit
     *
     * @notice payable function increases locked collateral by msg.value
     */
    function deposit(
        address _counterparty,
        bytes32 _ccy,
        uint256 _amount
    ) public override onlyRegisteredUser {
        require(Storage.slot().tokenAddresses[_ccy] != address(0), "Invalid currency");
        require(_amount > 0, "Invalid amount");
        _depositAssets(Storage.slot().tokenAddresses[_ccy], msg.sender, address(this), _amount);

        CollateralPosition.deposit(
            Storage.slot().positions[_ccy],
            msg.sender,
            _counterparty,
            _amount
        );

        Storage.Book storage book = Storage.slot().books[msg.sender][_ccy];
        book.lockedCollateral = book.lockedCollateral + _amount;

        _updateUsedCurrenciesInPosition(msg.sender, _counterparty, _ccy);

        emit PositionDeposit(msg.sender, _counterparty, _ccy, _amount);
    }

    /**
     * @dev Rebalances collateral between user's book and bilateral position
     *
     * @param _party0 First counterparty address
     * @param _party1 Second counterparty address.
     * @param _rebalanceTarget Amount of funds in ETH required to rebalance
     * @param isRebalanceFrom Boolean for whether collateral is rebalanced from a bilateral position or to a bilateral position
     *
     * @return Amount of funds in ETH left to rebalance for other vault
     */
    function rebalanceCollateral(
        address _party0,
        address _party1,
        uint256 _rebalanceTarget,
        bool isRebalanceFrom
    ) external onlyAcceptedContracts returns (bool) {
        EnumerableSet.Bytes32Set storage currencies = Storage.slot().usedCurrencies[_party0];
        uint256 len = currencies.length();
        uint256 i = 0;

        while (_rebalanceTarget != 0 && i < len) {
            bytes32 ccy = currencies.at(i);

            if (isRebalanceFrom) {
                _rebalanceTarget = _rebalanceFrom(_party0, _party1, ccy, _rebalanceTarget);
            } else {
                _rebalanceTarget = _rebalanceTo(_party0, _party1, ccy, _rebalanceTarget);
            }

            i += 1;
        }

        if (_rebalanceTarget > 0) return false;

        return true;
    }

    struct RebalanceLocalVars {
        int256 exchangeRate;
        uint256 target;
        uint256 rebalanceAmount;
        uint256 left;
    }

    /**
     * @dev Rebalances collateral between 2 different bilateral positions,
     * as it's executed by collateral aggregator function returns the
     * amount of ETH left to rebalance for other collateral vaults
     *
     * @param _user Main user address to rebalance collateral from
     * @param _fromParty Counterparty address to rebalance from
     * @param _toParty Counterparty address to rebalance to
     * @param _ccy Specified currency
     * @param _amountETH Amount of funds in ETH required to rebalance
     *
     * @return Amount of funds in ETH left to rebalance for other vault
     */
    function rebalanceBetween(
        address _user,
        address _fromParty,
        address _toParty,
        bytes32 _ccy,
        uint256 _amountETH
    ) external override onlyAcceptedContracts returns (uint256) {
        RebalanceLocalVars memory vars;

        vars.exchangeRate = currencyController().getLastETHPrice(_ccy);
        vars.target = (_amountETH * 1e18) / uint256(vars.exchangeRate);
        vars.rebalanceAmount = CollateralPosition.rebalance(
            Storage.slot().positions[_ccy],
            _user,
            _fromParty,
            _toParty,
            vars.target
        );
        vars.left = vars.target - vars.rebalanceAmount;

        _updateUsedCurrenciesInPosition(_user, _fromParty, _ccy);
        _updateUsedCurrenciesInPosition(_user, _toParty, _ccy);

        emit RebalanceBetween(_user, _fromParty, _toParty, _ccy, vars.rebalanceAmount);

        return (vars.left * uint256(vars.exchangeRate)) / 1e18;
    }

    /**
     * @dev Liquidates collateral from bilateral position between parties
     * returns the amount of ETH to be liquidated in other vault
     * if all available funds have been liquidated here
     *
     * @param _from Address for liquidating collateral from
     * @param _to Address for sending collateral to
     * @param _liquidationTarget Liquidation amount in ETH
     *
     * @notice Triggers only be Loan contract
     */
    function liquidate(
        address _from,
        address _to,
        uint256 _liquidationTarget
    ) external onlyAcceptedContracts returns (bool) {
        EnumerableSet.Bytes32Set storage currencies = Storage.slot().usedCurrencies[_from];
        uint256 len = currencies.length();
        uint256 i = 0;

        while (_liquidationTarget != 0 && i < len) {
            bytes32 ccy = currencies.at(i);
            _liquidationTarget = _liquidate(_from, _to, ccy, _liquidationTarget);

            i += 1;
        }

        if (_liquidationTarget > 0) return false;

        return true;
    }

    /**
     * @notice Triggers to withdraw funds by the msg.sender from non-locked funds
     * @param _ccy Specified currency
     * @param _amount Number of funds to withdraw.
     */
    function withdraw(bytes32 _ccy, uint256 _amount) public override onlyRegisteredUser {
        // fix according to collateral aggregator
        require(_amount > 0, "INVALID_AMOUNT");

        address user = msg.sender;
        uint256 maxWidthdrawETH = collateralAggregator().getMaxCollateralBookWidthdraw(user);
        uint256 maxWidthdraw = currencyController().convertFromETH(_ccy, maxWidthdrawETH);
        uint256 withdrawAmt = _amount > maxWidthdraw ? maxWidthdraw : _amount;

        Storage.Book storage book = Storage.slot().books[user][_ccy];
        book.independentAmount = book.independentAmount - withdrawAmt;

        _withdrawAssets(Storage.slot().tokenAddresses[_ccy], msg.sender, withdrawAmt);
        _updateUsedCurrencies(_ccy);

        emit Withdraw(msg.sender, _ccy, withdrawAmt);
    }

    /**
     * @notice Triggers to withdraw funds from bilateral position between
     * msg.sender and _counterparty
     *
     * @param _counterparty Counterparty address.
     * @param _ccy Specified currency
     * @param _amount Number of funds to withdraw.
     */
    function withdrawFrom(
        address _counterparty,
        bytes32 _ccy,
        uint256 _amount
    ) public override onlyRegisteredUser {
        require(_amount > 0, "INVALID_AMOUNT");
        address user = msg.sender;

        (uint256 maxWidthdrawETH, ) = collateralAggregator().getMaxCollateralWidthdraw(
            user,
            _counterparty
        );
        uint256 maxWidthdraw = currencyController().convertFromETH(_ccy, maxWidthdrawETH);

        uint256 targetWithdraw = _amount > maxWidthdraw ? maxWidthdraw : _amount;
        uint256 withdrawn = CollateralPosition.withdraw(
            Storage.slot().positions[_ccy],
            user,
            _counterparty,
            targetWithdraw
        );

        Storage.Book storage book = Storage.slot().books[user][_ccy];
        book.lockedCollateral = book.lockedCollateral - withdrawn;

        _withdrawAssets(Storage.slot().tokenAddresses[_ccy], msg.sender, withdrawn);
        _updateUsedCurrenciesInPosition(msg.sender, _counterparty, _ccy);

        emit PositionWithdraw(user, _counterparty, _ccy, withdrawn);
    }

    /**
     * @notice Returns independent collateral from `_user` collateral book
     *
     * @param _user Address of collateral user
     * @param _ccy Specified currency
     */
    function getIndependentCollateral(address _user, bytes32 _ccy)
        public
        view
        override
        returns (uint256)
    {
        return Storage.slot().books[_user][_ccy].independentAmount;
    }

    /**
     * @notice Returns independent collateral from `_user` collateral book converted to ETH
     *
     * @param _user Address of collateral user
     * @param _ccy Specified currency
     */
    function getIndependentCollateralInETH(address _user, bytes32 _ccy)
        public
        view
        override
        returns (uint256)
    {
        uint256 amount = getIndependentCollateral(_user, _ccy);
        return currencyController().convertToETH(_ccy, amount);
    }

    /**
     * @notice Returns independent collateral from `_user` collateral book converted to ETH
     *
     * @param _user Address of collateral user
     */
    function getTotalIndependentCollateralInETH(address _user)
        public
        view
        override
        returns (uint256)
    {
        EnumerableSet.Bytes32Set storage currencies = Storage.slot().usedCurrencies[_user];
        uint256 lockedCollateral;
        uint256 totalCollateral;

        uint256 len = currencies.length();

        for (uint256 i = 0; i < len; i++) {
            bytes32 ccy = currencies.at(i);
            lockedCollateral = getIndependentCollateralInETH(_user, ccy);
            totalCollateral = totalCollateral + lockedCollateral;
        }

        return totalCollateral;
    }

    /**
     * @notice Returns locked collateral by `_user` in collateral book
     *
     * @param _user Address of collateral user
     * @param _ccy Specified currency
     */
    function getLockedCollateral(address _user, bytes32 _ccy)
        public
        view
        override
        returns (uint256)
    {
        return Storage.slot().books[_user][_ccy].lockedCollateral;
    }

    /**
     * @notice Returns locked collateral by `_user` in collateral book converted to ETH
     *
     * @param _user Address of collateral user
     * @param _ccy Specified currency
     */
    function getLockedCollateralInETH(address _user, bytes32 _ccy)
        public
        view
        override
        returns (uint256)
    {
        uint256 amount = getLockedCollateral(_user, _ccy);
        return currencyController().convertToETH(_ccy, amount);
    }

    /**
     * @notice Returns locked collateral for a particular currency by counterparties
     * in a bilateral position in native `ccy`
     *
     * @param _party0 First counterparty address
     * @param _party1 Second counterparty address.
     * @param _ccy Specified currency
     */
    function getLockedCollateral(
        address _party0,
        address _party1,
        bytes32 _ccy
    ) public view override returns (uint256, uint256) {
        return CollateralPosition.get(Storage.slot().positions[_ccy], _party0, _party1);
    }

    /**
     * @notice Returns locked collateral for a particular currency by counterparties
     * in a bilateral position converted to ETH
     *
     * @param _party0 First counterparty address
     * @param _party1 Second counterparty address.
     * @param _ccy Specified currency
     */
    function getLockedCollateralInETH(
        address _party0,
        address _party1,
        bytes32 _ccy
    ) public view override returns (uint256, uint256) {
        (uint256 lockedA, uint256 lockedB) = getLockedCollateral(_party0, _party1, _ccy);

        uint256[] memory ethAmounts = new uint256[](2);
        ethAmounts[0] = lockedA;
        ethAmounts[1] = lockedB;

        ethAmounts = currencyController().convertBulkToETH(_ccy, ethAmounts);

        return (ethAmounts[0], ethAmounts[1]);
    }

    struct TotalLockedCollateralLocalVars {
        uint256 len;
        uint256 lockedCollateral0;
        uint256 lockedCollateral1;
        uint256 totalCollateral0;
        uint256 totalCollateral1;
    }

    /**
     * @notice Returns locked collateral by counterparties in a bilateral position converted to ETH
     *
     * @param _party0 First counterparty address
     * @param _party1 Second counterparty address.
     */
    function getTotalLockedCollateralInETH(address _party0, address _party1)
        public
        view
        override
        returns (uint256, uint256)
    {
        (bytes32 packedAddrs, ) = AddressPacking.pack(_party0, _party1);
        EnumerableSet.Bytes32Set storage currencies = Storage.slot().usedCurrenciesInPosition[
            packedAddrs
        ];

        TotalLockedCollateralLocalVars memory vars;
        vars.len = currencies.length();

        for (uint256 i = 0; i < vars.len; i++) {
            bytes32 ccy = currencies.at(i);

            (vars.lockedCollateral0, vars.lockedCollateral1) = getLockedCollateralInETH(
                _party0,
                _party1,
                ccy
            );

            vars.totalCollateral0 = vars.totalCollateral0 + vars.lockedCollateral0;
            vars.totalCollateral1 = vars.totalCollateral1 + vars.lockedCollateral1;
        }

        return (vars.totalCollateral0, vars.totalCollateral1);
    }

    function getUsedCurrencies(address _party0, address _party1)
        public
        view
        override
        returns (bytes32[] memory)
    {
        (bytes32 packedAddrs, ) = AddressPacking.pack(_party0, _party1);
        EnumerableSet.Bytes32Set storage currencySet = Storage.slot().usedCurrenciesInPosition[
            packedAddrs
        ];

        uint256 numCurrencies = currencySet.length();
        bytes32[] memory currencies = new bytes32[](numCurrencies);

        for (uint256 i = 0; i < numCurrencies; i++) {
            bytes32 currency = currencySet.at(i);
            currencies[i] = currency;
        }

        return currencies;
    }

    function getUsedCurrencies(address user) public view override returns (bytes32[] memory) {
        EnumerableSet.Bytes32Set storage currencySet = Storage.slot().usedCurrencies[user];

        uint256 numCurrencies = currencySet.length();
        bytes32[] memory currencies = new bytes32[](numCurrencies);

        for (uint256 i = 0; i < numCurrencies; i++) {
            bytes32 currency = currencySet.at(i);
            currencies[i] = currency;
        }

        return currencies;
    }

    /**
     * @dev Rebalances collateral from user's book to bilateral position,
     * as it's executed by collateral aggregator function returns the
     * amount of ETH left to rebalance for other collateral vaults
     *
     * @param _user Main user address to rebalance collateral from
     * @param _counterparty Counterparty address in bilateral position
     * @param _ccy Specified currency
     * @param _amountETH Amount of funds in ETH required to rebalance
     *
     * @return Amount of funds in ETH left to rebalance for other vault
     */
    function _rebalanceTo(
        address _user,
        address _counterparty,
        bytes32 _ccy,
        uint256 _amountETH
    ) internal returns (uint256) {
        RebalanceLocalVars memory vars;
        vars.exchangeRate = currencyController().getLastETHPrice(_ccy);
        vars.target = (_amountETH * 1e18) / uint256(vars.exchangeRate);

        Storage.Book storage book = Storage.slot().books[_user][_ccy];
        vars.rebalanceAmount = book.independentAmount >= vars.target
            ? vars.target
            : book.independentAmount;

        if (vars.rebalanceAmount > 0) {
            book.independentAmount = book.independentAmount - vars.rebalanceAmount;
            book.lockedCollateral = book.lockedCollateral + vars.rebalanceAmount;

            CollateralPosition.deposit(
                Storage.slot().positions[_ccy],
                _user,
                _counterparty,
                vars.rebalanceAmount
            );
            _updateUsedCurrenciesInPosition(_user, _counterparty, _ccy);

            emit RebalanceTo(_user, _counterparty, _ccy, vars.rebalanceAmount);
        }

        vars.left = vars.target - vars.rebalanceAmount;

        return (vars.left * uint256(vars.exchangeRate)) / 1e18;
    }

    /**
     * @dev Rebalances collateral from bilateral position to user's book,
     * as it's executed by collateral aggregator function returns the
     * amount of ETH left to rebalance for other collateral vaults
     *
     * @param _user Main user address to rebalance collateral from
     * @param _counterparty Counterparty address in bilateral position
     * @param _ccy Specified currency
     * @param _amountETH Amount of funds in ETH required to rebalance
     *
     * @return Amount of funds in ETH left to rebalance for other vault
     */
    function _rebalanceFrom(
        address _user,
        address _counterparty,
        bytes32 _ccy,
        uint256 _amountETH
    ) internal returns (uint256) {
        RebalanceLocalVars memory vars;
        vars.exchangeRate = currencyController().getLastETHPrice(_ccy);
        vars.target = (_amountETH * 1e18) / uint256(vars.exchangeRate);

        vars.rebalanceAmount = CollateralPosition.withdraw(
            Storage.slot().positions[_ccy],
            _user,
            _counterparty,
            vars.target
        );

        if (vars.rebalanceAmount > 0) {
            Storage.Book storage book = Storage.slot().books[_user][_ccy];
            book.lockedCollateral = book.lockedCollateral - vars.rebalanceAmount;
            book.independentAmount = book.independentAmount + vars.rebalanceAmount;

            _updateUsedCurrenciesInPosition(_user, _counterparty, _ccy);

            emit RebalanceFrom(_user, _counterparty, _ccy, vars.rebalanceAmount);
        }

        vars.left = vars.target - vars.rebalanceAmount;

        return (vars.left * uint256(vars.exchangeRate)) / 1e18;
    }

    function _liquidate(
        address _from,
        address _to,
        bytes32 _ccy,
        uint256 _amountETH
    ) internal returns (uint256 liquidationLeftETH) {
        int256 exchangeRate = currencyController().getLastETHPrice(_ccy);
        uint256 liquidationTarget = (_amountETH * 1e18) / uint256(exchangeRate);
        uint256 liquidated = CollateralPosition.liquidate(
            Storage.slot().positions[_ccy],
            _from,
            _to,
            liquidationTarget
        );

        Storage.Book storage book = Storage.slot().books[_from][_ccy];
        book.lockedCollateral = book.lockedCollateral - liquidated;

        book = Storage.slot().books[_to][_ccy];
        book.lockedCollateral = book.lockedCollateral + liquidated;

        if (liquidated > 0) {
            _updateUsedCurrenciesInPosition(_from, _to, _ccy);
            emit Liquidate(_from, _to, _ccy, liquidated);
        }

        uint256 liquidationLeft = liquidationTarget - liquidated;

        if (liquidationLeft > 0) {
            uint256 independentLiquidation = _tryLiquidateIndependentCollateral(
                _from,
                _to,
                _ccy,
                liquidationLeft
            );
            liquidationLeft = liquidationLeft - independentLiquidation;
        }

        liquidationLeftETH = (liquidationLeft * uint256(exchangeRate)) / 1e18;
    }

    function _tryLiquidateIndependentCollateral(
        address _from,
        address _to,
        bytes32 _ccy,
        uint256 _amount
    ) internal returns (uint256 liquidated) {
        uint256 maxWidthdrawETH = collateralAggregator().getMaxCollateralBookWidthdraw(_from);
        uint256 maxLiquidation = currencyController().convertFromETH(_ccy, maxWidthdrawETH);

        liquidated = _amount > maxLiquidation ? maxLiquidation : _amount;

        Storage.Book storage book = Storage.slot().books[_from][_ccy];
        book.independentAmount = book.independentAmount - liquidated;

        book = Storage.slot().books[_to][_ccy];
        book.lockedCollateral = book.lockedCollateral + liquidated;

        CollateralPosition.deposit(Storage.slot().positions[_ccy], _to, _from, liquidated);

        emit LiquidateIndependent(_from, _to, _ccy, liquidated);
    }

    function _updateUsedCurrencies(bytes32 _ccy) internal {
        if (
            Storage.slot().books[msg.sender][_ccy].independentAmount > 0 ||
            Storage.slot().books[msg.sender][_ccy].lockedCollateral > 0
        ) {
            Storage.slot().usedCurrencies[msg.sender].add(_ccy);
        } else {
            Storage.slot().usedCurrencies[msg.sender].remove(_ccy);
        }
    }

    function _updateUsedCurrenciesInPosition(
        address _user,
        address _counterparty,
        bytes32 _ccy
    ) internal {
        (uint256 locked0, uint256 locked1) = CollateralPosition.get(
            Storage.slot().positions[_ccy],
            _user,
            _counterparty
        );

        if (locked0 > 0) {
            Storage.slot().usedCurrencies[_user].add(_ccy);
        }

        if (locked1 > 0) {
            Storage.slot().usedCurrencies[_counterparty].add(_ccy);
        }

        (bytes32 packedAddrs, ) = AddressPacking.pack(_user, _counterparty);
        if (locked0 > 0 || locked1 > 0) {
            Storage.slot().usedCurrenciesInPosition[packedAddrs].add(_ccy);
        } else {
            Storage.slot().usedCurrenciesInPosition[packedAddrs].remove(_ccy);
        }
    }
}
