// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

interface IFutureValueVault {
    event Transfer(address indexed from, address indexed to, int256 value);

    function getTotalSupply(uint256 maturity) external view returns (uint256);

    function getFutureValue(address user)
        external
        view
        returns (int256 futureValue, uint256 maturity);

    function hasFutureValueInPastMaturity(address user, uint256 maturity)
        external
        view
        returns (bool);

    function addLendFutureValue(
        address user,
        uint256 amount,
        uint256 maturity,
        bool isTaker
    ) external;

    function addBorrowFutureValue(
        address user,
        uint256 amount,
        uint256 maturity,
        bool isTaker
    ) external;

    function transferFrom(
        address sender,
        address receiver,
        int256 amount,
        uint256 maturity
    ) external;

    function removeFutureValue(address user, uint256 activeMaturity)
        external
        returns (
            int256 removedAmount,
            int256 currentAmount,
            uint256 maturity,
            bool removeFutureValue
        );

    function addInitialTotalSupply(uint256 maturity, int256 amount) external;

    function executeForcedReset(address user) external;

    function executeForcedReset(address user, int256 amount)
        external
        returns (int256 removedAmount, int256 balance);
}
