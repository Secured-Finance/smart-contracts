// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "../libraries/CollateralPosition.sol";

library CollateralVaultStorage {
    using CollateralPosition for CollateralPosition.Position;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    bytes32 internal constant STORAGE_SLOT = keccak256("sf.storage.collateralVault");

    struct Book {
        uint256 independentAmount;
        uint256 lockedCollateral;
    }

    struct Storage {
        mapping(bytes32 => address) tokenAddresses;
        // Mapping for used currency vaults in bilateral position.
        mapping(bytes32 => EnumerableSet.Bytes32Set) usedCurrenciesInPosition;
        // Mapping for used currency vaults per user.
        mapping(address => EnumerableSet.Bytes32Set) usedCurrencies;
        // Mapping for all deposits of currency per users collateral
        mapping(address => mapping(bytes32 => Book)) books;
        // Mapping for bilateral collateral positions between 2 counterparties per currency
        mapping(bytes32 => mapping(bytes32 => CollateralPosition.Position)) positions;
    }

    function slot() internal pure returns (Storage storage r) {
        bytes32 _slot = STORAGE_SLOT;
        /// @solidity memory-safe-assembly
        assembly {
            r.slot := _slot
        }
    }
}
