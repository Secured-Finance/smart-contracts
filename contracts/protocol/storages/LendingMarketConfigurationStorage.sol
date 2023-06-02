// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

library LendingMarketConfigurationStorage {
    bytes32 internal constant STORAGE_SLOT = keccak256("sf.storage.lendingMarketConfiguration");

    struct Storage {
        // Mapping from currency to order fee rate received by protocol (in basis point)
        mapping(bytes32 => uint256) orderFeeRates;
        // Mapping from currency to auto-roll fee rate received by protocol (in basis point)
        mapping(bytes32 => uint256) autoRollFeeRates;
        // Mapping from currency to rate limit range of yield for the circuit breaker
        mapping(bytes32 => uint256) circuitBreakerLimitRanges;
        // The period to calculate the volume-weighted average price of transactions to use as auto-roll fee rate.
        uint256 observationPeriod;
    }

    function slot() internal pure returns (Storage storage r) {
        bytes32 _slot = STORAGE_SLOT;
        /// @solidity memory-safe-assembly
        assembly {
            r.slot := _slot
        }
    }
}