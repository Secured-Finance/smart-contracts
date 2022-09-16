// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

library TokenVaultStorage {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    bytes32 internal constant STORAGE_SLOT = keccak256("sf.storage.tokenVault");

    struct Storage {
        // Mapping from user to total unsettled collateral per currency
        mapping(address => mapping(bytes32 => uint256)) unsettledCollateral;
        // Mapping from user to unsettled exposure
        mapping(address => EnumerableSet.Bytes32Set) exposedUnsettledCurrencies;
        // Mapping from currency name to token address
        mapping(bytes32 => address) tokenAddresses;
        // Mapping for used currency vaults per user.
        mapping(address => EnumerableSet.Bytes32Set) usedCurrencies;
        // Mapping for all deposits of currency per users collateral
        mapping(address => mapping(bytes32 => uint256)) collateralAmounts;
        // Mapping from user to total escrowed amount per currency
        mapping(address => mapping(bytes32 => uint256)) escrowedAmount;
    }

    function slot() internal pure returns (Storage storage r) {
        bytes32 _slot = STORAGE_SLOT;
        /// @solidity memory-safe-assembly
        assembly {
            r.slot := _slot
        }
    }
}