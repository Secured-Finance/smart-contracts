// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

struct Currency {
    bool isSupported;
    string name;
}

library CurrencyControllerStorage {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    bytes32 internal constant STORAGE_SLOT = keccak256("sf.storage.currencyController");

    struct Storage {
        // Protocol currencies
        EnumerableSet.Bytes32Set currencies;
        mapping(bytes32 => uint256) haircuts;
        // PriceFeed
        mapping(bytes32 => AggregatorV3Interface) usdPriceFeeds;
        mapping(bytes32 => AggregatorV3Interface) ethPriceFeeds;
        mapping(bytes32 => uint8) usdDecimals;
        mapping(bytes32 => uint8) ethDecimals;
    }

    function slot() internal pure returns (Storage storage r) {
        bytes32 _slot = STORAGE_SLOT;
        /// @solidity memory-safe-assembly
        assembly {
            r.slot := _slot
        }
    }
}