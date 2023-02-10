// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

library FutureValueVaultStorage {
    bytes32 internal constant STORAGE_SLOT = keccak256("sf.storage.futureValueVault");

    struct Storage {
        address lendingMarket;
        // Mapping from user to balances
        mapping(address => int256) balances;
        // Mapping from user to maturity
        mapping(address => uint256) futureValueMaturities;
        // Mapping from maturity to the total amount supplied
        mapping(uint256 => uint256) totalSupply;
        // Mapping from maturity to the total removed amount of lending
        mapping(uint256 => uint256) removedLendingSupply;
        // Mapping from maturity to the total removed amount of borrowing
        mapping(uint256 => uint256) removedBorrowingSupply;
    }

    function slot() internal pure returns (Storage storage r) {
        bytes32 _slot = STORAGE_SLOT;
        /// @solidity memory-safe-assembly
        assembly {
            r.slot := _slot
        }
    }
}
