// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import {AutoRollLog} from "../storages/GenesisValueVaultStorage.sol";

interface IGenesisValueVault {
    event Transfer(bytes32 indexed ccy, address indexed from, address indexed to, int256 value);
    event AutoRollExecuted(
        bytes32 indexed ccy,
        uint256 lendingCompoundFactor,
        uint256 borrowingCompoundFactor,
        uint256 unitPrice,
        uint256 currentMaturity,
        uint256 previousMaturity
    );

    function isInitialized(bytes32 ccy) external view returns (bool);

    function decimals(bytes32 ccy) external view returns (uint8);

    function getTotalLendingSupply(bytes32 ccy) external view returns (uint256);

    function getTotalBorrowingSupply(bytes32 ccy) external view returns (uint256);

    function getGenesisValue(bytes32 ccy, address user) external view returns (int256);

    function getMaturityGenesisValue(bytes32 ccy, uint256 maturity) external view returns (int256);

    function getCurrentMaturity(bytes32 ccy) external view returns (uint256);

    function getLendingCompoundFactor(bytes32 ccy) external view returns (uint256);

    function getBorrowingCompoundFactor(bytes32 ccy) external view returns (uint256);

    function getAutoRollLog(bytes32 ccy, uint256 maturity)
        external
        view
        returns (AutoRollLog memory);

    function getLatestAutoRollLog(bytes32 ccy) external view returns (AutoRollLog memory);

    function getGenesisValueInFutureValue(bytes32 ccy, address user) external view returns (int256);

    function calculateFVFromFV(
        bytes32 ccy,
        uint256 basisMaturity,
        uint256 destinationMaturity,
        int256 futureValue
    ) external view returns (int256);

    function calculateGVFromFV(
        bytes32 ccy,
        uint256 basisMaturity,
        int256 futureValue
    ) external view returns (int256);

    function calculateFVFromGV(
        bytes32 ccy,
        uint256 basisMaturity,
        int256 genesisValue
    ) external view returns (int256);

    function getBalanceFluctuationByAutoRolls(
        bytes32 ccy,
        address user,
        uint256 maturity
    ) external view returns (int256 fluctuation);

    function calculateBalanceFluctuationByAutoRolls(
        bytes32 ccy,
        int256 balance,
        uint256 fromMaturity,
        uint256 toMaturity
    ) external view returns (int256 fluctuation);

    function initializeCurrencySetting(
        bytes32 ccy,
        uint8 decimals,
        uint256 compoundFactor,
        uint256 maturity
    ) external;

    function updateInitialCompoundFactor(bytes32 ccy, uint256 unitPrice) external;

    function executeAutoRoll(
        bytes32 ccy,
        uint256 maturity,
        uint256 nextMaturity,
        uint256 unitPrice,
        uint256 orderFeeRate
    ) external;

    function updateGenesisValueWithFutureValue(
        bytes32 ccy,
        address user,
        uint256 basisMaturity,
        int256 fvAmount
    ) external;

    function updateGenesisValueWithResidualAmount(
        bytes32 ccy,
        address user,
        uint256 basisMaturity
    ) external;

    function transferFrom(
        bytes32 ccy,
        address sender,
        address receiver,
        int256 amount
    ) external;

    function cleanUpGenesisValue(
        bytes32 ccy,
        address user,
        uint256 maturity
    ) external;

    function resetGenesisValue(bytes32 ccy, address user) external;
}
