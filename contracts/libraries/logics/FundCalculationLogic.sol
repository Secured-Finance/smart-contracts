// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
// interfaces
import {ILendingMarket} from "../../interfaces/ILendingMarket.sol";
import {IFutureValueVault} from "../../interfaces/IFutureValueVault.sol";
// libraries
import {AddressResolverLib} from "../AddressResolverLib.sol";
import {QuickSort} from "../QuickSort.sol";
import {RoundingUint256} from "../math/RoundingUint256.sol";
import {RoundingInt256} from "../math/RoundingInt256.sol";
// types
import {ProtocolTypes} from "../../types/ProtocolTypes.sol";
// storages
import {LendingMarketControllerStorage as Storage} from "../../storages/LendingMarketControllerStorage.sol";

library FundCalculationLogic {
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.UintSet;
    using SafeCast for uint256;
    using SafeCast for int256;
    using RoundingUint256 for uint256;
    using RoundingInt256 for int256;

    struct CalculatedAmountVars {
        address debtMarket;
        uint256 debtFVAmount;
        uint256 debtPVAmount;
        int256 futureValueAmount;
        uint256 estimatedDebtPVAmount;
        uint256 liquidationPVAmountInETH;
        uint256 liquidationPVAmount;
        int256 offsetGVAmount;
    }

    struct CalculatedTotalFundInETHVars {
        bool[] isCollateral;
        bytes32 ccy;
        uint256[] amounts;
        uint256[] amountsInETH;
        uint256 plusDepositAmount;
        uint256 minusDepositAmount;
    }

    struct ActualFunds {
        int256 presentValue;
        int256 futureValue;
        uint256 workingLendingOrdersAmount;
        uint256 lentAmount;
        uint256 workingBorrowingOrdersAmount;
        uint256 borrowedAmount;
        int256 genesisValue;
    }

    struct CalculateActualFundsVars {
        bool isTotal;
        address market;
        uint256 maturity;
        bool isDefaultMarket;
        uint256[] maturities;
    }

    struct FutureValueVaultFunds {
        int256 genesisValue;
        int256 presentValue;
        int256 futureValue;
    }

    struct InactiveBorrowingOrdersFunds {
        int256 genesisValue;
        int256 presentValue;
        int256 futureValue;
        uint256 workingBorrowingOrdersAmount;
        uint256 borrowedAmount;
    }

    struct InactiveLendingOrdersFunds {
        int256 genesisValue;
        int256 presentValue;
        int256 futureValue;
        uint256 workingLendingOrdersAmount;
        uint256 lentAmount;
    }

    function convertToLiquidationAmountFromCollateral(
        address _liquidator,
        address _user,
        bytes32 _collateralCcy,
        bytes32 _debtCcy,
        uint256 _debtMaturity,
        uint24 _poolFee
    ) public returns (uint256 liquidationPVAmount, uint256 offsetPVAmount) {
        CalculatedAmountVars memory vars;

        vars.liquidationPVAmountInETH = AddressResolverLib.tokenVault().getLiquidationAmount(_user);
        require(vars.liquidationPVAmountInETH != 0, "User has enough collateral");

        vars.futureValueAmount = calculateActualFunds(_debtCcy, _debtMaturity, _user).futureValue;
        require(vars.futureValueAmount < 0, "No debt in the selected maturity");

        vars.debtMarket = Storage.slot().maturityLendingMarkets[_debtCcy][_debtMaturity];
        vars.debtFVAmount = (-vars.futureValueAmount).toUint256();
        vars.debtPVAmount = _calculatePVFromFVInMaturity(
            _debtCcy,
            _debtMaturity,
            -vars.futureValueAmount,
            vars.debtMarket
        ).toUint256();

        vars.liquidationPVAmount = AddressResolverLib.currencyController().convertFromETH(
            _debtCcy,
            vars.liquidationPVAmountInETH
        );

        // If the debt amount is less than the liquidation amount, the debt amount is used as the liquidation amount.
        // In that case, the actual liquidation ratio is under the liquidation threshold ratio.
        vars.liquidationPVAmount = vars.liquidationPVAmount > vars.debtPVAmount
            ? vars.debtPVAmount
            : vars.liquidationPVAmount;

        if (!AddressResolverLib.reserveFund().isPaused()) {
            // Offset the user's debt using the future value amount and the genesis value amount hold by the reserve fund contract.
            // Before this step, the target user's order must be cleaned up by `LendingMarketController#cleanOrders` function.
            // If the target market is the nearest market(default market), the genesis value is used for the offset.
            bool isDefaultMarket = Storage.slot().maturityLendingMarkets[_debtCcy][_debtMaturity] ==
                Storage.slot().lendingMarkets[_debtCcy][0];

            if (isDefaultMarket) {
                vars.offsetGVAmount = AddressResolverLib.genesisValueVault().offsetGenesisValue(
                    _debtCcy,
                    _debtMaturity,
                    address(AddressResolverLib.reserveFund()),
                    _user,
                    AddressResolverLib.genesisValueVault().calculateGVFromFV(
                        _debtCcy,
                        _debtMaturity,
                        vars.liquidationPVAmount.toInt256()
                    )
                );

                if (vars.offsetGVAmount > 0) {
                    offsetPVAmount = _calculatePVFromFVInMaturity(
                        _debtCcy,
                        _debtMaturity,
                        AddressResolverLib.genesisValueVault().calculateFVFromGV(
                            _debtCcy,
                            _debtMaturity,
                            vars.offsetGVAmount
                        ),
                        vars.debtMarket
                    ).toUint256();
                }
            }

            uint256 offsetFVAmount = _offsetFutureValue(
                _debtCcy,
                _debtMaturity,
                address(AddressResolverLib.reserveFund()),
                _user,
                _calculateFVFromPV(
                    _debtCcy,
                    _debtMaturity,
                    vars.liquidationPVAmount - offsetPVAmount
                )
            );

            if (offsetFVAmount > 0) {
                offsetPVAmount += _calculatePVFromFVInMaturity(
                    _debtCcy,
                    _debtMaturity,
                    offsetFVAmount.toInt256(),
                    vars.debtMarket
                ).toUint256();
            }
        }

        // Estimate the filled amount from actual orders in the order book using the future value of user debt.
        // If the estimated amount is less than the liquidation amount, the estimated amount is used as
        // the liquidation amount.
        vars.estimatedDebtPVAmount = ILendingMarket(
            Storage.slot().maturityLendingMarkets[_debtCcy][_debtMaturity]
        ).estimateFilledAmount(ProtocolTypes.Side.LEND, vars.debtFVAmount);

        uint256 swapPVAmount = vars.liquidationPVAmount > vars.estimatedDebtPVAmount
            ? vars.estimatedDebtPVAmount
            : vars.liquidationPVAmount;

        // Swap collateral from deposited currency to debt currency using Uniswap.
        // This swapped collateral is used to unwind the debt.
        liquidationPVAmount = AddressResolverLib.tokenVault().swapDepositAmounts(
            _liquidator,
            _user,
            _collateralCcy,
            _debtCcy,
            swapPVAmount,
            _poolFee,
            offsetPVAmount
        );
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
        } else {
            vars.isTotal = false;
            vars.market = Storage.slot().maturityLendingMarkets[_ccy][_maturity];
            vars.isDefaultMarket = vars.market == Storage.slot().lendingMarkets[_ccy][0];
            vars.maturity = _maturity;
        }
        actualFunds.genesisValue = AddressResolverLib.genesisValueVault().getGenesisValue(
            _ccy,
            _user
        );

        vars.maturities = Storage.slot().usedMaturities[_ccy][_user].values();
        if (vars.maturities.length > 0) {
            vars.maturities = QuickSort.sort(vars.maturities);
        }

        for (uint256 i = 0; i < vars.maturities.length; i++) {
            address currentMarket = Storage.slot().maturityLendingMarkets[_ccy][vars.maturities[i]];
            uint256 currentMaturity = ILendingMarket(currentMarket).getMaturity();
            bool isDefaultMarket = currentMarket == Storage.slot().lendingMarkets[_ccy][0];

            if (vars.isTotal || vars.isDefaultMarket || currentMarket == vars.market) {
                // Get PV from Future Value Vault
                FutureValueVaultFunds memory futureValueVaultFunds = _getFundsFromFutureValueVault(
                    _ccy,
                    _user,
                    vars,
                    currentMaturity,
                    currentMarket,
                    isDefaultMarket
                );
                actualFunds.genesisValue += futureValueVaultFunds.genesisValue;
                actualFunds.presentValue += futureValueVaultFunds.presentValue;
                actualFunds.futureValue += futureValueVaultFunds.futureValue;

                // Get PV from inactive borrow orders
                InactiveBorrowingOrdersFunds
                    memory inactiveBorrowingOrdersFunds = _getFundsFromInactiveBorrowingOrders(
                        _ccy,
                        _user,
                        vars,
                        currentMaturity,
                        currentMarket,
                        isDefaultMarket
                    );
                actualFunds.workingBorrowingOrdersAmount += inactiveBorrowingOrdersFunds
                    .workingBorrowingOrdersAmount;
                actualFunds.borrowedAmount += inactiveBorrowingOrdersFunds.borrowedAmount;
                actualFunds.genesisValue -= inactiveBorrowingOrdersFunds.genesisValue;
                actualFunds.presentValue -= inactiveBorrowingOrdersFunds.presentValue;
                actualFunds.futureValue -= inactiveBorrowingOrdersFunds.futureValue;

                // Get PV from inactive lend orders
                InactiveLendingOrdersFunds
                    memory inactiveLendingOrdersFunds = _getFundsFromInactiveLendingOrders(
                        _ccy,
                        _user,
                        vars,
                        currentMaturity,
                        currentMarket,
                        isDefaultMarket
                    );
                actualFunds.workingLendingOrdersAmount += inactiveLendingOrdersFunds
                    .workingLendingOrdersAmount;
                actualFunds.lentAmount += inactiveLendingOrdersFunds.lentAmount;
                actualFunds.genesisValue += inactiveLendingOrdersFunds.genesisValue;
                actualFunds.presentValue += inactiveLendingOrdersFunds.presentValue;
                actualFunds.futureValue += inactiveLendingOrdersFunds.futureValue;

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

        // Add PV from Genesis Value Vault if the market is that the lending position is rolled to.
        if ((vars.isTotal || vars.isDefaultMarket) && actualFunds.genesisValue != 0) {
            int256 futureValue = AddressResolverLib.genesisValueVault().calculateFVFromGV(
                _ccy,
                0,
                actualFunds.genesisValue
            );
            actualFunds.presentValue += _calculatePVFromFV(
                futureValue,
                ILendingMarket(Storage.slot().lendingMarkets[_ccy][0]).getMidUnitPrice()
            );
            actualFunds.futureValue += futureValue;
        }
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
                if (vars.isTotal || vars.isDefaultMarket) {
                    // genesis value
                    funds.genesisValue = AddressResolverLib.genesisValueVault().calculateGVFromFV(
                        _ccy,
                        fvMaturity,
                        futureValueInMaturity
                    );
                }
            } else if (currentMaturity == fvMaturity) {
                if (
                    vars.isTotal ||
                    (vars.isDefaultMarket && isDefaultMarket) ||
                    !vars.isDefaultMarket
                ) {
                    (funds.presentValue, funds.futureValue) = _calculatePVandFVFromFVInMaturity(
                        _ccy,
                        fvMaturity,
                        vars.maturity,
                        futureValueInMaturity
                    );
                }
            }
        }
    }

    function _getFundsFromInactiveBorrowingOrders(
        bytes32 _ccy,
        address _user,
        CalculateActualFundsVars memory vars,
        uint256 currentMaturity,
        address currentMarket,
        bool isDefaultMarket
    ) internal view returns (InactiveBorrowingOrdersFunds memory funds) {
        uint256 borrowFVInMaturity;
        uint256 borrowOrdersMaturity;
        (
            funds.workingBorrowingOrdersAmount,
            funds.borrowedAmount,
            borrowFVInMaturity,
            borrowOrdersMaturity
        ) = ILendingMarket(currentMarket).getTotalAmountFromBorrowOrders(_user);

        if (borrowFVInMaturity != 0) {
            if (currentMaturity != borrowOrdersMaturity) {
                if (vars.isTotal || vars.isDefaultMarket) {
                    funds.genesisValue = AddressResolverLib.genesisValueVault().calculateGVFromFV(
                        _ccy,
                        borrowOrdersMaturity,
                        borrowFVInMaturity.toInt256()
                    );
                }
            } else if (currentMaturity == borrowOrdersMaturity) {
                if (
                    vars.isTotal ||
                    (vars.isDefaultMarket && isDefaultMarket) ||
                    !vars.isDefaultMarket
                ) {
                    (funds.presentValue, funds.futureValue) = _calculatePVandFVFromFVInMaturity(
                        _ccy,
                        borrowOrdersMaturity,
                        vars.maturity,
                        borrowFVInMaturity.toInt256()
                    );
                }
            }
        }
    }

    function _getFundsFromInactiveLendingOrders(
        bytes32 _ccy,
        address _user,
        CalculateActualFundsVars memory vars,
        uint256 currentMaturity,
        address currentMarket,
        bool isDefaultMarket
    ) internal view returns (InactiveLendingOrdersFunds memory funds) {
        uint256 lendFVInMaturity;
        uint256 lendOrdersMaturity;
        (
            funds.workingLendingOrdersAmount,
            funds.lentAmount,
            lendFVInMaturity,
            lendOrdersMaturity
        ) = ILendingMarket(currentMarket).getTotalAmountFromLendOrders(_user);

        if (lendFVInMaturity != 0) {
            if (currentMaturity != lendOrdersMaturity) {
                if (vars.isTotal || vars.isDefaultMarket) {
                    funds.genesisValue += AddressResolverLib.genesisValueVault().calculateGVFromFV(
                        _ccy,
                        lendOrdersMaturity,
                        lendFVInMaturity.toInt256()
                    );
                }
            } else if (currentMaturity == lendOrdersMaturity) {
                if (
                    vars.isTotal ||
                    (vars.isDefaultMarket && isDefaultMarket) ||
                    !vars.isDefaultMarket
                ) {
                    (funds.presentValue, funds.futureValue) = _calculatePVandFVFromFVInMaturity(
                        _ccy,
                        lendOrdersMaturity,
                        vars.maturity,
                        lendFVInMaturity.toInt256()
                    );
                }
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
        workingLendOrdersAmount = funds.workingLendingOrdersAmount;
        lentAmount = funds.lentAmount;
        workingBorrowOrdersAmount = funds.workingBorrowingOrdersAmount;
        borrowedAmount = funds.borrowedAmount;

        if (funds.presentValue > 0) {
            claimableAmount = (funds.presentValue).toUint256();
            uint256 haircut = AddressResolverLib.currencyController().getHaircut(_ccy);
            collateralAmount = (claimableAmount * haircut).div(ProtocolTypes.PCT_DIGIT);
        } else if (funds.presentValue < 0) {
            debtAmount = (-funds.presentValue).toUint256();
        }
    }

    function calculateTotalFundsInETH(
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
        CalculatedTotalFundInETHVars memory vars;

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

            vars.amountsInETH = AddressResolverLib.currencyController().convertToETH(
                vars.ccy,
                vars.amounts
            );

            totalClaimableAmount += vars.amountsInETH[1];
            totalCollateralAmount += vars.amountsInETH[2];
            totalWorkingBorrowOrdersAmount += vars.amountsInETH[4];
            totalDebtAmount += vars.amountsInETH[5];

            // NOTE: Lent amount and working lend orders amount are excluded here as they are not used
            // for the collateral calculation.
            // Those amounts need only to check whether there is enough deposit amount in the selected currency.
            if (vars.isCollateral[i]) {
                totalWorkingLendOrdersAmount += vars.amountsInETH[0];
                totalLentAmount += vars.amountsInETH[3];
                totalBorrowedAmount += vars.amountsInETH[6];
            }
        }

        // Check if the user has enough collateral in the selected currency.
        isEnoughDeposit = vars.plusDepositAmount >= vars.minusDepositAmount;
    }

    function _calculatePVandFVFromFVInMaturity(
        bytes32 _ccy,
        uint256 _basisMaturity,
        uint256 _destinationMaturity,
        int256 _futureValueInBasisMaturity
    ) internal view returns (int256 presetValue, int256 futureValue) {
        require(_basisMaturity >= _destinationMaturity, "Invalid destination maturity");

        address destinationMarket = _destinationMaturity == 0
            ? Storage.slot().lendingMarkets[_ccy][0]
            : Storage.slot().maturityLendingMarkets[_ccy][_destinationMaturity];
        uint256 unitPriceInDestinationMaturity = ILendingMarket(destinationMarket)
            .getMidUnitPrice();

        if (
            AddressResolverLib
                .genesisValueVault()
                .getAutoRollLog(_ccy, _destinationMaturity)
                .unitPrice == 0
        ) {
            uint256 unitPriceInBasisMaturity = ILendingMarket(
                Storage.slot().maturityLendingMarkets[_ccy][_basisMaturity]
            ).getMidUnitPrice();
            presetValue = _calculatePVFromFV(_futureValueInBasisMaturity, unitPriceInBasisMaturity);
            futureValue = (presetValue * ProtocolTypes.PRICE_DIGIT.toInt256()).div(
                unitPriceInDestinationMaturity.toInt256()
            );
        } else {
            futureValue = AddressResolverLib.genesisValueVault().calculateFVFromFV(
                _ccy,
                _basisMaturity,
                _destinationMaturity,
                _futureValueInBasisMaturity
            );
            presetValue = _calculatePVFromFV(futureValue, unitPriceInDestinationMaturity);
        }
    }

    function _calculateFVFromPV(
        bytes32 _ccy,
        uint256 _maturity,
        uint256 _presentValue
    ) internal view returns (uint256) {
        uint256 unitPrice = ILendingMarket(Storage.slot().maturityLendingMarkets[_ccy][_maturity])
            .getMidUnitPrice();

        // NOTE: The formula is: futureValue = presentValue / unitPrice.
        return (_presentValue * ProtocolTypes.PRICE_DIGIT).div(unitPrice);
    }

    function _calculatePVFromFVInMaturity(
        bytes32 _ccy,
        uint256 maturity,
        int256 futureValueInMaturity,
        address lendingMarketInMaturity
    ) internal view returns (int256 totalPresentValue) {
        uint256 unitPriceInMaturity = AddressResolverLib
            .genesisValueVault()
            .getAutoRollLog(_ccy, maturity)
            .unitPrice;
        int256 futureValue;
        uint256 unitPrice;

        if (unitPriceInMaturity == 0) {
            futureValue = futureValueInMaturity;
            unitPrice = ILendingMarket(lendingMarketInMaturity).getMidUnitPrice();
        } else {
            futureValue = AddressResolverLib.genesisValueVault().calculateFVFromFV(
                _ccy,
                maturity,
                0,
                futureValueInMaturity
            );
            unitPrice = ILendingMarket(Storage.slot().lendingMarkets[_ccy][0]).getMidUnitPrice();
        }

        return _calculatePVFromFV(futureValue, unitPrice);
    }

    function _calculatePVFromFV(int256 _futureValue, uint256 _unitPrice)
        internal
        pure
        returns (int256)
    {
        // NOTE: The formula is: presentValue = futureValue * unitPrice.
        return (_futureValue * _unitPrice.toInt256()).div(ProtocolTypes.PRICE_DIGIT.toInt256());
    }

    function _offsetFutureValue(
        bytes32 _ccy,
        uint256 _maturity,
        address _lender,
        address _borrower,
        uint256 _maximumFVAmount
    ) internal returns (uint256 offsetAmount) {
        address market = Storage.slot().maturityLendingMarkets[_ccy][_maturity];
        address futureValueVault = Storage.slot().futureValueVaults[_ccy][market];

        offsetAmount = IFutureValueVault(futureValueVault).offsetFutureValue(
            _lender,
            _borrower,
            _maximumFVAmount
        );
    }
}
