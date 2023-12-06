// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

library AddressResolverStorage {
    bytes32 internal constant STORAGE_SLOT =
        bytes32(uint256(keccak256("sf.storage.addressResolver")) - 1);

    struct Storage {
        mapping(bytes32 contractName => address contractAddress) addresses;
        bytes32[] nameCaches;
        address[] addressCaches;
    }

    function slot() internal pure returns (Storage storage r) {
        bytes32 _slot = STORAGE_SLOT;
        /// @solidity memory-safe-assembly
        assembly {
            r.slot := _slot
        }
    }
}
