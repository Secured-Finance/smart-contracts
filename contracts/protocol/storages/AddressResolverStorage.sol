// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

library AddressResolverStorage {
    bytes32 internal constant STORAGE_SLOT = keccak256("sf.storage.addressResolver");

    struct Storage {
        mapping(bytes32 contractName => address contractAddress) addresses;
        // Contract address list
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
