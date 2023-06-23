// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import {EnumerableSet} from "../../../dependencies/openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {SafeCast} from "../../../dependencies/openzeppelin/contracts/utils/math/SafeCast.sol";
// interfaces
import {ILendingMarket} from "../../interfaces/ILendingMarket.sol";
import {ILendingMarketController} from "../../interfaces/ILendingMarketController.sol";
import {IFutureValueVault} from "../../interfaces/IFutureValueVault.sol";
// libraries
import {AddressResolverLib} from "../AddressResolverLib.sol";
import {QuickSort} from "../QuickSort.sol";
import {Constants} from "../Constants.sol";
import {RoundingUint256} from "../math/RoundingUint256.sol";
import {RoundingInt256} from "../math/RoundingInt256.sol";
// types
import {ProtocolTypes} from "../../types/ProtocolTypes.sol";
// storages
import {LendingMarketControllerStorage as Storage} from "../../storages/LendingMarketControllerStorage.sol";
// liquidation
import {ILiquidationReceiver} from "../../../liquidators/interfaces/ILiquidationReceiver.sol";

library FundManagementLogic {
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.UintSet;
    using SafeCast for uint256;
    using SafeCast for int256;
    using RoundingUint256 for uint256;
    using RoundingInt256 for int256;

    struct CalculatedTotalFundInBaseCurrencyVars {
        bool[] isCollateral;
        bytes32 ccy;
        uint256[] amounts;
        uint256[] amountsInBaseCurrency;
        uint256 plusDepositAmount;
        uint256 minusDepositAmount;
    }

    struct ActualFunds {
        int256 presentValue;
        uint256 claimableAmount;
        uint256 debtAmount;
        int256 futureValue;
        uint256 workingLendOrdersAmount;
        uint256 lentAmount;
        uint256 workingBorrowOrdersAmount;
        uint256 borrowedAmount;
        int256 genesisValue;
    }

    struct CalculateActualFundsVars {
        bool isTotal;
        address market;
        bool isDefaultMarket;
        uint256[] maturities;
        int256 presentValueOfDefaultMarket;
    }

    struct FutureValueVaultFunds {
        int256 genesisValue;
        int256 presentValue;
        int256 futureValue;
    }

    struct InactiveBorrowOrdersFunds {
        int256 genesisValue;
        int256 presentValue;
        int256 futureValue;
        uint256 workingOrdersAmount;
        uint256 borrowedAmount;
    }

    struct InactiveLendOrdersFunds {
        int256 genesisValue;
        int256 presentValue;
        int256 futureValue;
        uint256 workingOrdersAmount;
        uint256 lentAmount;
    }

    event OrderFilled(
        address indexed taker,
        bytes32 indexed ccy,
        ProtocolTypes.Side side,
        uint256 indexed maturity,
        uint256 amount,
        uint256 futureValue
    );

    event OrdersFilledInAsync(
        address indexed taker,
        bytes32 indexed ccy,
        ProtocolTypes.Side side,
        uint256 indexed maturity,
        uint256 amount,
        uint256 futureValue
    );

    event RedemptionExecuted(
        address indexed user,
        bytes32 indexed ccy,
        uint256 indexed maturity,
        uint256 amount
    );

    event RepaymentExecuted(
        address indexed user,
        bytes32 indexed ccy,
        uint256 indexed maturity,
        uint256 amount
    );

    event EmergencySettlementExecuted(address indexed user, uint256 amount);

    /**
     * @notice Converts the future value to the genesis value if there is balance in the past maturity.
     * @param _ccy Currency for pausing all lending markets
     * @param _user User's address
     * @return Current future value amount after update
     */
    function convertFutureValueToGenesisValue(
        bytes32 _ccy,
        uint256 _maturity,
        address _user
    ) public returns (int256) {
        address futureValueVault = Storage.slot().futureValueVaults[_ccy][
            Storage.slot().maturityLendingMarkets[_ccy][_maturity]
        ];
        (
            int256 removedAmount,
            int256 currentAmount,
            uint256 basisMaturity,
            bool isAllRemoved
        ) = IFutureValueVault(futureValueVault).removeFutureValue(_user, _maturity);

        if (removedAmount != 0) {
            // Overwrite the `removedAmount` with the unsettled amount left of the Genesis Value
            // to handle the fractional amount generated by the lazy evaluation.
            if (isAllRemoved) {
                AddressResolverLib.genesisValueVault().updateGenesisValueWithResidualAmount(
                    _ccy,
                    _user,
                    basisMaturity
                );
            } else {
                AddressResolverLib.genesisValueVault().updateGenesisValueWithFutureValue(
                    _ccy,
                    _user,
                    basisMaturity,
                    removedAmount
                );
            }
        }

        return currentAmount;
    }

    function updateFunds(
        bytes32 _ccy,
        uint256 _maturity,
        address _user,
        ProtocolTypes.Side _side,
        uint256 _filledAmount,
        uint256 _filledAmountInFV,
        uint256 _orderFeeRate,
        bool _isTaker
    ) external {
        address futureValueVault = Storage.slot().futureValueVaults[_ccy][
            Storage.slot().maturityLendingMarkets[_ccy][_maturity]
        ];

        uint256 feeInFV = _isTaker
            ? _calculateOrderFeeAmount(_maturity, _filledAmountInFV, _orderFeeRate)
            : 0;

        if (_side == ProtocolTypes.Side.BORROW) {
            AddressResolverLib.tokenVault().addDepositAmount(_user, _ccy, _filledAmount);
            IFutureValueVault(futureValueVault).addBorrowFutureValue(
                _user,
                _filledAmountInFV + feeInFV,
                _maturity,
                _isTaker
            );
        } else {
            AddressResolverLib.tokenVault().removeDepositAmount(_user, _ccy, _filledAmount);
            IFutureValueVault(futureValueVault).addLendFutureValue(
                _user,
                _filledAmountInFV - feeInFV,
                _maturity,
                _isTaker
            );
        }

        if (feeInFV > 0) {
            address reserveFundAddr = address(AddressResolverLib.reserveFund());
            IFutureValueVault(futureValueVault).addLendFutureValue(
                reserveFundAddr,
                feeInFV,
                _maturity,
                _side == ProtocolTypes.Side.LEND
            );

            registerCurrencyAndMaturity(_ccy, _maturity, reserveFundAddr);
        }

        emit OrderFilled(_user, _ccy, _side, _maturity, _filledAmount, _filledAmountInFV);
    }

    function registerCurrencyAndMaturity(
        bytes32 _ccy,
        uint256 _maturity,
        address _user
    ) public {
        if (!Storage.slot().usedMaturities[_ccy][_user].contains(_maturity)) {
            Storage.slot().usedMaturities[_ccy][_user].add(_maturity);

            if (!Storage.slot().usedCurrencies[_user].contains(_ccy)) {
                Storage.slot().usedCurrencies[_user].add(_ccy);
            }
        }
    }

    function executeRedemption(
        bytes32 _ccy,
        uint256 _maturity,
        address _user
    ) external {
        require(block.timestamp >= _maturity + 1 weeks, "Not in the redemption period");

        cleanUpFunds(_ccy, _user);

        int256 amount = calculateActualFunds(_ccy, _maturity, _user).futureValue;
        require(amount > 0, "No redemption amount");

        uint256 redemptionAmount = _resetFundsPerMaturity(_ccy, _maturity, _user, amount)
            .toUint256();
        AddressResolverLib.tokenVault().addDepositAmount(_user, _ccy, redemptionAmount);

        emit RedemptionExecuted(_user, _ccy, _maturity, redemptionAmount);
    }

    function executeRepayment(
        bytes32 _ccy,
        uint256 _maturity,
        address _user,
        uint256 _amount
    ) public returns (uint256 repaymentAmount) {
        require(block.timestamp >= _maturity, "Market is not matured");

        cleanUpFunds(_ccy, _user);

        int256 resetAmount = _amount == 0
            ? calculateActualFunds(_ccy, _maturity, _user).futureValue
            : -_amount.toInt256();

        require(resetAmount < 0, "No repayment amount");

        repaymentAmount = (-_resetFundsPerMaturity(_ccy, _maturity, _user, resetAmount)).toUint256();
        AddressResolverLib.tokenVault().removeDepositAmount(_user, _ccy, repaymentAmount);

        emit RepaymentExecuted(_user, _ccy, _maturity, repaymentAmount);
    }

    function executeEmergencySettlement(address _user) external {
        require(!Storage.slot().isRedeemed[_user], "Already redeemed");

        int256 redemptionAmountInBaseCurrency;

        bytes32[] memory currencies = Storage.slot().usedCurrencies[_user].values();

        for (uint256 i; i < currencies.length; i++) {
            bytes32 ccy = currencies[i];
            // First, clean up future values and genesis values to redeem those amounts.
            cleanUpFunds(ccy, _user);

            int256 amountInCcy = _resetFundsPerCurrency(ccy, _user);
            redemptionAmountInBaseCurrency += _convertToBaseCurrencyAtMarketTerminationPrice(
                ccy,
                amountInCcy
            );
        }

        bytes32[] memory collateralCurrencies = AddressResolverLib
            .tokenVault()
            .getCollateralCurrencies();

        for (uint256 i; i < collateralCurrencies.length; i++) {
            int256 amountInCcy = AddressResolverLib
                .tokenVault()
                .resetDepositAmount(_user, collateralCurrencies[i])
                .toInt256();

            redemptionAmountInBaseCurrency += _convertToBaseCurrencyAtMarketTerminationPrice(
                collateralCurrencies[i],
                amountInCcy
            );
        }

        if (redemptionAmountInBaseCurrency > 0) {
            uint256[] memory marketTerminationRatios = new uint256[](collateralCurrencies.length);
            uint256 marketTerminationRatioTotal;

            for (uint256 i; i < collateralCurrencies.length; i++) {
                bytes32 ccy = collateralCurrencies[i];
                marketTerminationRatios[i] = Storage.slot().marketTerminationRatios[ccy];
                marketTerminationRatioTotal += marketTerminationRatios[i];
            }

            for (uint256 i; i < collateralCurrencies.length; i++) {
                bytes32 ccy = collateralCurrencies[i];
                uint256 addedAmount = _convertFromBaseCurrencyAtMarketTerminationPrice(
                    ccy,
                    (redemptionAmountInBaseCurrency.toUint256() * marketTerminationRatios[i]).div(
                        marketTerminationRatioTotal
                    )
                );

                AddressResolverLib.tokenVault().addDepositAmount(_user, ccy, addedAmount);
            }
        } else if (redemptionAmountInBaseCurrency < 0) {
            revert("Insufficient collateral");
        }

        Storage.slot().isRedeemed[_user] = true;
        emit EmergencySettlementExecuted(_user, redemptionAmountInBaseCurrency.toUint256());
    }

    function calculateActualFunds(
        bytes32 _ccy,
        uint256 _maturity,
        address _user
    ) public view returns (ActualFunds memory actualFunds) {
        CalculateActualFundsVars memory vars;

        if (_maturity == 0) {
            vars.isTotal = true;
            vars.market = Storage.slot().lendingMarkets[_ccy][0];
            vars.isDefaultMarket = true;
        } else {
            vars.isTotal = false;
            vars.market = Storage.slot().maturityLendingMarkets[_ccy][_maturity];
            vars.isDefaultMarket = vars.market == Storage.slot().lendingMarkets[_ccy][0];
        }
        actualFunds.genesisValue = AddressResolverLib.genesisValueVault().getGenesisValue(
            _ccy,
            _user
        );

        vars.maturities = getUsedMaturities(_ccy, _user);

        for (uint256 i = 0; i < vars.maturities.length; i++) {
            address currentMarket = Storage.slot().maturityLendingMarkets[_ccy][vars.maturities[i]];
            uint256 currentMaturity = ILendingMarket(currentMarket).getMaturity();
            bool isDefaultMarket = currentMarket == Storage.slot().lendingMarkets[_ccy][0];

            if (vars.isDefaultMarket || currentMarket == vars.market) {
                // Get current funds from Future Value Vault by lazy evaluations.
                FutureValueVaultFunds memory futureValueVaultFunds = _getFundsFromFutureValueVault(
                    _ccy,
                    _user,
                    vars,
                    currentMaturity,
                    currentMarket,
                    isDefaultMarket
                );
                // Get current funds from borrowing orders by lazy evaluations.
                InactiveBorrowOrdersFunds
                    memory borrowOrdersFunds = _getFundsFromInactiveBorrowOrders(
                        _ccy,
                        _user,
                        vars,
                        currentMaturity,
                        currentMarket,
                        isDefaultMarket
                    );
                // Get current funds from lending orders by lazy evaluations.
                InactiveLendOrdersFunds memory lendOrdersFunds = _getFundsFromInactiveLendOrders(
                    _ccy,
                    _user,
                    vars,
                    currentMaturity,
                    currentMarket,
                    isDefaultMarket
                );

                // Set genesis value.
                actualFunds.genesisValue +=
                    futureValueVaultFunds.genesisValue -
                    borrowOrdersFunds.genesisValue +
                    lendOrdersFunds.genesisValue;

                // Set present value.
                int256 presentValue = futureValueVaultFunds.presentValue -
                    borrowOrdersFunds.presentValue +
                    lendOrdersFunds.presentValue;

                actualFunds.presentValue += presentValue;

                if (isDefaultMarket) {
                    vars.presentValueOfDefaultMarket = presentValue;
                }

                if (presentValue > 0) {
                    actualFunds.claimableAmount += presentValue.toUint256();
                } else if (presentValue < 0) {
                    actualFunds.debtAmount += (-presentValue).toUint256();
                }

                // Set future value.
                // Note: When calculating total funds, total future value will be 0 because different maturities can not be added.
                if (!vars.isTotal) {
                    actualFunds.futureValue +=
                        futureValueVaultFunds.futureValue -
                        borrowOrdersFunds.futureValue +
                        lendOrdersFunds.futureValue;
                }

                actualFunds.workingBorrowOrdersAmount += borrowOrdersFunds.workingOrdersAmount;
                actualFunds.workingLendOrdersAmount += lendOrdersFunds.workingOrdersAmount;
                actualFunds.borrowedAmount += borrowOrdersFunds.borrowedAmount;
                actualFunds.lentAmount += lendOrdersFunds.lentAmount;

                // Get balance fluctuation amount by auto-rolls
                if (actualFunds.genesisValue < 0) {
                    int256 fluctuation = AddressResolverLib
                        .genesisValueVault()
                        .calculateBalanceFluctuationByAutoRolls(
                            _ccy,
                            actualFunds.genesisValue,
                            vars.maturities[i],
                            i == vars.maturities.length - 1 ? 0 : vars.maturities[i + 1]
                        );

                    actualFunds.genesisValue += fluctuation;
                }
            }
        }

        // Add GV to PV & FV if the market is that the lending position is rolled to.
        if (vars.isDefaultMarket && actualFunds.genesisValue != 0) {
            int256 futureValue = AddressResolverLib.genesisValueVault().calculateFVFromGV(
                _ccy,
                0,
                actualFunds.genesisValue
            );

            int256 presentValue = calculatePVFromFV(
                futureValue,
                ILendingMarket(Storage.slot().lendingMarkets[_ccy][0]).getMidUnitPrice()
            );

            actualFunds.presentValue += presentValue;

            // Add GV to the claimable amount or debt amount.
            // Before that, offset the present value of the default market and the genesis value in addition.
            if (presentValue > 0) {
                if (vars.presentValueOfDefaultMarket < 0) {
                    int256 offsetAmount = presentValue > -vars.presentValueOfDefaultMarket
                        ? -vars.presentValueOfDefaultMarket
                        : presentValue;
                    actualFunds.debtAmount -= (offsetAmount).toUint256();
                    presentValue -= offsetAmount;
                }

                actualFunds.claimableAmount += presentValue.toUint256();
            } else if (presentValue < 0) {
                if (vars.presentValueOfDefaultMarket > 0) {
                    int256 offsetAmount = -presentValue > vars.presentValueOfDefaultMarket
                        ? vars.presentValueOfDefaultMarket
                        : -presentValue;

                    actualFunds.claimableAmount -= (offsetAmount).toUint256();
                    presentValue += offsetAmount;
                }

                actualFunds.debtAmount += (-presentValue).toUint256();
            }

            if (!vars.isTotal) {
                actualFunds.futureValue += futureValue;
            }
        }
    }

    function calculateFunds(bytes32 _ccy, address _user)
        public
        view
        returns (
            uint256 workingLendOrdersAmount,
            uint256 claimableAmount,
            uint256 collateralAmount,
            uint256 lentAmount,
            uint256 workingBorrowOrdersAmount,
            uint256 debtAmount,
            uint256 borrowedAmount
        )
    {
        ActualFunds memory funds = calculateActualFunds(_ccy, 0, _user);

        workingLendOrdersAmount = funds.workingLendOrdersAmount;
        lentAmount = funds.lentAmount;
        workingBorrowOrdersAmount = funds.workingBorrowOrdersAmount;
        borrowedAmount = funds.borrowedAmount;
        claimableAmount = funds.claimableAmount;
        debtAmount = funds.debtAmount;

        if (claimableAmount > 0) {
            uint256 haircut = AddressResolverLib.currencyController().getHaircut(_ccy);
            collateralAmount = (claimableAmount * haircut).div(Constants.PCT_DIGIT);
        }
    }

    function calculateTotalFundsInBaseCurrency(
        address _user,
        bytes32 _depositCcy,
        uint256 _depositAmount
    )
        external
        view
        returns (
            uint256 totalWorkingLendOrdersAmount,
            uint256 totalClaimableAmount,
            uint256 totalCollateralAmount,
            uint256 totalLentAmount,
            uint256 totalWorkingBorrowOrdersAmount,
            uint256 totalDebtAmount,
            uint256 totalBorrowedAmount,
            bool isEnoughDeposit
        )
    {
        EnumerableSet.Bytes32Set storage currencySet = Storage.slot().usedCurrencies[_user];
        CalculatedTotalFundInBaseCurrencyVars memory vars;

        vars.isCollateral = AddressResolverLib.tokenVault().isCollateral(currencySet.values());
        vars.plusDepositAmount = _depositAmount;

        // Calculate total funds from the user's order list
        for (uint256 i = 0; i < currencySet.length(); i++) {
            vars.ccy = currencySet.at(i);
            vars.amounts = new uint256[](7);

            // 0: workingLendOrdersAmount
            // 1: claimableAmount
            // 2: collateralAmount
            // 3: lentAmount
            // 4: workingBorrowOrdersAmount
            // 5: debtAmount
            // 6: borrowedAmount
            (
                vars.amounts[0],
                vars.amounts[1],
                vars.amounts[2],
                vars.amounts[3],
                vars.amounts[4],
                vars.amounts[5],
                vars.amounts[6]
            ) = calculateFunds(vars.ccy, _user);

            if (vars.ccy == _depositCcy) {
                // plusDepositAmount: depositAmount + borrowedAmount
                // minusDepositAmount: workingLendOrdersAmount + lentAmount
                vars.plusDepositAmount += vars.amounts[6];
                vars.minusDepositAmount += vars.amounts[0] + vars.amounts[3];
            }

            vars.amountsInBaseCurrency = AddressResolverLib
                .currencyController()
                .convertToBaseCurrency(vars.ccy, vars.amounts);

            totalClaimableAmount += vars.amountsInBaseCurrency[1];
            totalCollateralAmount += vars.amountsInBaseCurrency[2];
            totalWorkingBorrowOrdersAmount += vars.amountsInBaseCurrency[4];
            totalDebtAmount += vars.amountsInBaseCurrency[5];

            // NOTE: Lent amount and working lend orders amount are excluded here as they are not used
            // for the collateral calculation.
            // Those amounts need only to check whether there is enough deposit amount in the selected currency.
            if (vars.isCollateral[i]) {
                totalWorkingLendOrdersAmount += vars.amountsInBaseCurrency[0];
                totalLentAmount += vars.amountsInBaseCurrency[3];
                totalBorrowedAmount += vars.amountsInBaseCurrency[6];
            }
        }

        // Check if the user has enough collateral in the selected currency.
        isEnoughDeposit = vars.plusDepositAmount >= vars.minusDepositAmount;
    }

    function getUsedMaturities(bytes32 _ccy, address _user)
        public
        view
        returns (uint256[] memory maturities)
    {
        maturities = Storage.slot().usedMaturities[_ccy][_user].values();
        if (maturities.length > 0) {
            maturities = QuickSort.sort(maturities);
        }
    }

    function getPositions(bytes32[] memory _ccys, address _user)
        external
        view
        returns (ILendingMarketController.Position[] memory positions)
    {
        uint256 totalPositionCount;

        ILendingMarketController.Position[][]
            memory positionLists = new ILendingMarketController.Position[][](_ccys.length);

        for (uint256 i; i < _ccys.length; i++) {
            positionLists[i] = getPositionsPerCurrency(_ccys[i], _user);
            totalPositionCount += positionLists[i].length;
        }

        positions = new ILendingMarketController.Position[](totalPositionCount);
        uint256 index;
        for (uint256 i; i < positionLists.length; i++) {
            for (uint256 j; j < positionLists[i].length; j++) {
                positions[index] = positionLists[i][j];
                index++;
            }
        }
    }

    function getPositionsPerCurrency(bytes32 _ccy, address _user)
        public
        view
        returns (ILendingMarketController.Position[] memory positions)
    {
        address[] memory lendingMarkets = Storage.slot().lendingMarkets[_ccy];
        positions = new ILendingMarketController.Position[](lendingMarkets.length);
        uint256 positionIdx;

        for (uint256 i; i < lendingMarkets.length; i++) {
            uint256 maturity = ILendingMarket(lendingMarkets[i]).getMaturity();
            (int256 presentValue, int256 futureValue) = getPosition(_ccy, maturity, _user);

            if (futureValue == 0) {
                assembly {
                    mstore(positions, sub(mload(positions), 1))
                }
            } else {
                positions[positionIdx] = ILendingMarketController.Position(
                    _ccy,
                    maturity,
                    presentValue,
                    futureValue
                );
                positionIdx++;
            }
        }
    }

    function getPosition(
        bytes32 _ccy,
        uint256 _maturity,
        address _user
    ) public view returns (int256 presentValue, int256 futureValue) {
        FundManagementLogic.ActualFunds memory funds = calculateActualFunds(_ccy, _maturity, _user);
        presentValue = funds.presentValue;
        futureValue = funds.futureValue;
    }

    function cleanUpAllFunds(address _user) external {
        EnumerableSet.Bytes32Set storage ccySet = Storage.slot().usedCurrencies[_user];
        for (uint256 i = 0; i < ccySet.length(); i++) {
            cleanUpFunds(ccySet.at(i), _user);
        }
    }

    function cleanUpFunds(bytes32 _ccy, address _user)
        public
        returns (uint256 totalActiveOrderCount)
    {
        bool futureValueExists = false;
        uint256[] memory maturities = getUsedMaturities(_ccy, _user);

        for (uint256 j = 0; j < maturities.length; j++) {
            ILendingMarket market = ILendingMarket(
                Storage.slot().maturityLendingMarkets[_ccy][maturities[j]]
            );
            uint256 activeMaturity = market.getMaturity();
            int256 currentFutureValue = convertFutureValueToGenesisValue(
                _ccy,
                activeMaturity,
                _user
            );
            (uint256 activeOrderCount, bool isCleaned) = _cleanUpOrders(
                _ccy,
                activeMaturity,
                _user
            );

            totalActiveOrderCount += activeOrderCount;

            if (isCleaned) {
                currentFutureValue = convertFutureValueToGenesisValue(_ccy, activeMaturity, _user);
            }

            if (currentFutureValue != 0) {
                futureValueExists = true;
            }

            if (currentFutureValue == 0 && activeOrderCount == 0) {
                Storage.slot().usedMaturities[_ccy][_user].remove(maturities[j]);
            }

            AddressResolverLib.genesisValueVault().cleanUpGenesisValue(
                _ccy,
                _user,
                j == maturities.length - 1 ? 0 : maturities[j + 1]
            );
        }

        if (
            totalActiveOrderCount == 0 &&
            !futureValueExists &&
            AddressResolverLib.genesisValueVault().getGenesisValue(_ccy, _user) == 0
        ) {
            Storage.slot().usedCurrencies[_user].remove(_ccy);
        }
    }

    function _cleanUpOrders(
        bytes32 _ccy,
        uint256 _maturity,
        address _user
    ) internal returns (uint256 activeOrderCount, bool isCleaned) {
        address futureValueVault = Storage.slot().futureValueVaults[_ccy][
            Storage.slot().maturityLendingMarkets[_ccy][_maturity]
        ];

        (
            uint256 activeLendOrderCount,
            uint256 activeBorrowOrderCount,
            uint256 removedLendOrderFutureValue,
            uint256 removedBorrowOrderFutureValue,
            uint256 removedLendOrderAmount,
            uint256 removedBorrowOrderAmount,
            uint256 userCurrentMaturity
        ) = ILendingMarket(Storage.slot().maturityLendingMarkets[_ccy][_maturity]).cleanUpOrders(
                _user
            );

        if (removedLendOrderAmount > removedBorrowOrderAmount) {
            AddressResolverLib.tokenVault().removeDepositAmount(
                _user,
                _ccy,
                removedLendOrderAmount - removedBorrowOrderAmount
            );
        } else if (removedLendOrderAmount < removedBorrowOrderAmount) {
            AddressResolverLib.tokenVault().addDepositAmount(
                _user,
                _ccy,
                removedBorrowOrderAmount - removedLendOrderAmount
            );
        }

        if (removedLendOrderFutureValue > 0) {
            IFutureValueVault(futureValueVault).addLendFutureValue(
                _user,
                removedLendOrderFutureValue,
                userCurrentMaturity,
                false
            );
            emit OrdersFilledInAsync(
                _user,
                _ccy,
                ProtocolTypes.Side.LEND,
                userCurrentMaturity,
                removedLendOrderAmount,
                removedLendOrderFutureValue
            );
        }

        if (removedBorrowOrderFutureValue > 0) {
            IFutureValueVault(futureValueVault).addBorrowFutureValue(
                _user,
                removedBorrowOrderFutureValue,
                userCurrentMaturity,
                false
            );
            emit OrdersFilledInAsync(
                _user,
                _ccy,
                ProtocolTypes.Side.BORROW,
                userCurrentMaturity,
                removedBorrowOrderAmount,
                removedBorrowOrderFutureValue
            );
        }

        isCleaned = (removedLendOrderFutureValue + removedBorrowOrderFutureValue) > 0;
        activeOrderCount = activeLendOrderCount + activeBorrowOrderCount;
    }

    function _getFundsFromFutureValueVault(
        bytes32 _ccy,
        address _user,
        CalculateActualFundsVars memory vars,
        uint256 currentMaturity,
        address currentMarket,
        bool isDefaultMarket
    ) internal view returns (FutureValueVaultFunds memory funds) {
        (int256 futureValueInMaturity, uint256 fvMaturity) = IFutureValueVault(
            Storage.slot().futureValueVaults[_ccy][currentMarket]
        ).getFutureValue(_user);

        if (futureValueInMaturity != 0) {
            if (currentMaturity != fvMaturity) {
                if (vars.isDefaultMarket) {
                    funds.genesisValue = AddressResolverLib.genesisValueVault().calculateGVFromFV(
                        _ccy,
                        fvMaturity,
                        futureValueInMaturity
                    );
                }
            } else if (currentMaturity == fvMaturity) {
                if (vars.isTotal && !isDefaultMarket) {
                    (funds.presentValue, funds.futureValue) = _calculatePVandFVInDefaultMarket(
                        _ccy,
                        fvMaturity,
                        futureValueInMaturity
                    );
                } else if (vars.isTotal || !vars.isDefaultMarket || isDefaultMarket) {
                    funds.futureValue = futureValueInMaturity;
                    funds.presentValue = calculatePVFromFV(_ccy, fvMaturity, futureValueInMaturity);
                }
            }
        }
    }

    function _getFundsFromInactiveBorrowOrders(
        bytes32 _ccy,
        address _user,
        CalculateActualFundsVars memory vars,
        uint256 currentMaturity,
        address currentMarket,
        bool isDefaultMarket
    ) internal view returns (InactiveBorrowOrdersFunds memory funds) {
        uint256 filledFutureValue;
        uint256 orderMaturity;
        (
            funds.workingOrdersAmount,
            funds.borrowedAmount,
            filledFutureValue,
            orderMaturity
        ) = ILendingMarket(currentMarket).getTotalAmountFromBorrowOrders(_user);

        if (filledFutureValue != 0) {
            if (currentMaturity != orderMaturity) {
                if (vars.isDefaultMarket) {
                    funds.genesisValue = AddressResolverLib.genesisValueVault().calculateGVFromFV(
                        _ccy,
                        orderMaturity,
                        filledFutureValue.toInt256()
                    );
                }
            } else if (currentMaturity == orderMaturity) {
                if (vars.isTotal && !isDefaultMarket) {
                    (funds.presentValue, funds.futureValue) = _calculatePVandFVInDefaultMarket(
                        _ccy,
                        orderMaturity,
                        filledFutureValue.toInt256()
                    );
                } else if (vars.isTotal || !vars.isDefaultMarket || isDefaultMarket) {
                    funds.futureValue = filledFutureValue.toInt256();
                    funds.presentValue = calculatePVFromFV(_ccy, orderMaturity, funds.futureValue);
                }
            }
        }
    }

    function _getFundsFromInactiveLendOrders(
        bytes32 _ccy,
        address _user,
        CalculateActualFundsVars memory vars,
        uint256 currentMaturity,
        address currentMarket,
        bool isDefaultMarket
    ) internal view returns (InactiveLendOrdersFunds memory funds) {
        uint256 filledFutureValue;
        uint256 orderMaturity;
        (
            funds.workingOrdersAmount,
            funds.lentAmount,
            filledFutureValue,
            orderMaturity
        ) = ILendingMarket(currentMarket).getTotalAmountFromLendOrders(_user);

        if (filledFutureValue != 0) {
            if (currentMaturity != orderMaturity) {
                if (vars.isDefaultMarket) {
                    funds.genesisValue += AddressResolverLib.genesisValueVault().calculateGVFromFV(
                        _ccy,
                        orderMaturity,
                        filledFutureValue.toInt256()
                    );
                }
            } else if (currentMaturity == orderMaturity) {
                if (vars.isTotal && !isDefaultMarket) {
                    (funds.presentValue, funds.futureValue) = _calculatePVandFVInDefaultMarket(
                        _ccy,
                        orderMaturity,
                        filledFutureValue.toInt256()
                    );
                } else if (vars.isTotal || !vars.isDefaultMarket || isDefaultMarket) {
                    funds.futureValue = filledFutureValue.toInt256();
                    funds.presentValue = calculatePVFromFV(_ccy, orderMaturity, funds.futureValue);
                }
            }
        }
    }

    function _calculatePVandFVInDefaultMarket(
        bytes32 _ccy,
        uint256 _maturity,
        int256 _futureValueInMaturity
    ) internal view returns (int256 presentValue, int256 futureValue) {
        address destinationMarket = Storage.slot().lendingMarkets[_ccy][0];
        uint256 unitPriceInDestinationMaturity = ILendingMarket(destinationMarket)
            .getMidUnitPrice();

        if (AddressResolverLib.genesisValueVault().getAutoRollLog(_ccy, _maturity).unitPrice == 0) {
            presentValue = calculatePVFromFV(_ccy, _maturity, _futureValueInMaturity);
            futureValue = (presentValue * Constants.PRICE_DIGIT.toInt256()).div(
                unitPriceInDestinationMaturity.toInt256()
            );
        } else {
            futureValue = AddressResolverLib.genesisValueVault().calculateFVFromFV(
                _ccy,
                _maturity,
                0,
                _futureValueInMaturity
            );
            presentValue = calculatePVFromFV(futureValue, unitPriceInDestinationMaturity);
        }
    }

    function calculatePVFromFV(
        bytes32 _ccy,
        uint256 _maturity,
        int256 _futureValue
    ) public view returns (int256 presentValue) {
        uint256 unitPriceInBasisMaturity = ILendingMarket(
            Storage.slot().maturityLendingMarkets[_ccy][_maturity]
        ).getMidUnitPrice();
        presentValue = calculatePVFromFV(_futureValue, unitPriceInBasisMaturity);
    }

    function calculateFVFromPV(
        bytes32 _ccy,
        uint256 _maturity,
        int256 _presentValue
    ) public view returns (int256) {
        int256 unitPrice = ILendingMarket(Storage.slot().maturityLendingMarkets[_ccy][_maturity])
            .getMidUnitPrice()
            .toInt256();

        // NOTE: The formula is: futureValue = presentValue / unitPrice.
        return (_presentValue * Constants.PRICE_DIGIT.toInt256()).div(unitPrice);
    }

    function calculatePVFromFV(int256 _futureValue, uint256 _unitPrice)
        public
        pure
        returns (int256)
    {
        // NOTE: The formula is: presentValue = futureValue * unitPrice.
        return (_futureValue * _unitPrice.toInt256()).div(Constants.PRICE_DIGIT.toInt256());
    }

    function _convertToBaseCurrencyAtMarketTerminationPrice(bytes32 _ccy, int256 _amount)
        internal
        view
        returns (int256)
    {
        if (_ccy == Storage.slot().baseCurrency) {
            return _amount;
        } else {
            uint8 decimals = AddressResolverLib.currencyController().getDecimals(_ccy);

            return
                (_amount * Storage.slot().marketTerminationPrices[_ccy]).div(
                    (10**decimals).toInt256()
                );
        }
    }

    function _convertFromBaseCurrencyAtMarketTerminationPrice(bytes32 _ccy, uint256 _amount)
        internal
        view
        returns (uint256)
    {
        if (_ccy == Storage.slot().baseCurrency) {
            return _amount;
        } else {
            uint8 decimals = AddressResolverLib.currencyController().getDecimals(_ccy);
            return
                (_amount * 10**decimals).div(
                    Storage.slot().marketTerminationPrices[_ccy].toUint256()
                );
        }
    }

    function _calculateOrderFeeAmount(
        uint256 _maturity,
        uint256 _amount,
        uint256 _orderFeeRate
    ) internal view returns (uint256 orderFeeAmount) {
        require(block.timestamp < _maturity, "Invalid maturity");
        uint256 currentMaturity = _maturity - block.timestamp;

        // NOTE: The formula is:
        // actualRate = feeRate * (currentMaturity / SECONDS_IN_YEAR)
        // orderFeeAmount = amount * actualRate
        orderFeeAmount = (_orderFeeRate * currentMaturity * _amount).div(
            Constants.SECONDS_IN_YEAR * Constants.PCT_DIGIT
        );
    }

    function _resetFundsPerCurrency(bytes32 _ccy, address _user) internal returns (int256 amount) {
        amount = calculateActualFunds(_ccy, 0, _user).presentValue;

        uint256[] memory maturities = Storage.slot().usedMaturities[_ccy][_user].values();
        for (uint256 j; j < maturities.length; j++) {
            IFutureValueVault(
                Storage.slot().futureValueVaults[_ccy][
                    Storage.slot().maturityLendingMarkets[_ccy][maturities[j]]
                ]
            ).executeForcedReset(_user);
        }

        AddressResolverLib.genesisValueVault().executeForcedReset(_ccy, _user);

        Storage.slot().usedCurrencies[_user].remove(_ccy);
    }

    function _resetFundsPerMaturity(
        bytes32 _ccy,
        uint256 _maturity,
        address _user,
        int256 _amount
    ) internal returns (int256 totalRemovedAmount) {
        int256 currentFVAmount;
        int256 currentGVAmount;

        (totalRemovedAmount, currentFVAmount) = IFutureValueVault(
            Storage.slot().futureValueVaults[_ccy][
                Storage.slot().maturityLendingMarkets[_ccy][_maturity]
            ]
        ).executeForcedReset(_user, _amount);

        int256 remainingAmount = _amount - totalRemovedAmount;

        bool isDefaultMarket = Storage.slot().maturityLendingMarkets[_ccy][_maturity] ==
            Storage.slot().lendingMarkets[_ccy][0];

        if (isDefaultMarket && remainingAmount != 0) {
            int256 removedAmount;
            (removedAmount, currentGVAmount) = AddressResolverLib
                .genesisValueVault()
                .executeForcedReset(_ccy, _maturity, _user, remainingAmount);
            totalRemovedAmount += removedAmount;
        }

        if (currentFVAmount == 0 && currentGVAmount == 0) {
            Storage.slot().usedMaturities[_ccy][_user].remove(_maturity);

            if (Storage.slot().usedMaturities[_ccy][_user].length() == 0) {
                Storage.slot().usedCurrencies[_user].remove(_ccy);
            }
        }
    }
}
