// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "../types/ProtocolTypes.sol";

struct Order {
    bytes32 ccy;
    uint256 term;
    ProtocolTypes.Side side;
    uint256 amount;
    uint256 rate;
}

interface ILendingMarketController {
    event LendingMarketCreated(bytes32 ccy, address indexed marketAddr, uint256 index);
    event LendingMarketsPaused(bytes32 ccy);
    event LendingMarketsUnpaused(bytes32 ccy);

    event LendingMarketsRotated(bytes32 ccy, uint256 oldMaturity, uint256 newMaturity);

    function getBasisDate(bytes32 _ccy) external view returns (uint256);

    function getLendingMarkets(bytes32 _ccy) external view returns (address[] memory);

    function getBorrowRates(bytes32 _ccy) external view returns (uint256[] memory rates);

    function getLendRates(bytes32 _ccy) external view returns (uint256[] memory rates);

    function getMidRates(bytes32 _ccy) external view returns (uint256[] memory rates);

    function getMaturities(bytes32 _ccy) external view returns (uint256[] memory);

    function getTotalPresentValue(bytes32 ccy, address account) external view returns (int256);

    function getBeaconProxyAddress(bytes32 beaconName) external view returns (address);

    function setLendingMarketImpl(address newImpl) external;

    function setGenesisValueTokenImpl(address newImpl) external;

    function initializeLendingMarket(
        bytes32 _ccy,
        uint256 _basisDate,
        uint256 _compoundFactor
    ) external;

    function createLendingMarket(bytes32 _ccy) external returns (address market);

    function rotateLendingMarkets(bytes32 _ccy) external;

    function pauseLendingMarkets(bytes32 _ccy) external returns (bool);

    function unpauseLendingMarkets(bytes32 _ccy) external returns (bool);
}
