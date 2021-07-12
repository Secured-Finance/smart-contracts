// SPDX-License-Identifier: MIT
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "./IDiscountFactors.sol";

interface ILendingMarketController is IDiscountFactors {
    event LendingMarketCreated(uint8 ccy, uint8 term, address indexed marketAddr);
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);

    function lendingMarkets(uint8 , uint8) external view returns (address);
    function owner() external view returns (address);
    function setOwner(address _owner) external;
    function getBorrowRatesForCcy(uint8 _ccy) external view returns (uint256[6] memory rates);
    function getLendRatesForCcy(uint8 _ccy) external view returns (uint256[6] memory rates);
    function getMidRatesForCcy(uint8 _ccy) external view returns (uint256[6] memory rates);
    function getDiscountFactorsForCcy(uint8 _ccy) external view returns (DiscountFactor memory);
    function deployLendingMarket(uint8 _ccy, uint8 _term) external  returns (address market);
}