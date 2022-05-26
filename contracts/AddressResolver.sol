// SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IAddressResolver.sol";

contract AddressResolver is IAddressResolver, Ownable {
    mapping(bytes32 => address) public addresses;

    constructor() Ownable() {}

    function importAddresses(
        bytes32[] calldata _names,
        address[] calldata _addresses
    ) external onlyOwner {
        require(_names.length == _addresses.length, "Input lengths must match");

        for (uint256 i = 0; i < _names.length; i++) {
            bytes32 name = _names[i];
            address destination = _addresses[i];
            addresses[name] = destination;
            emit AddressImported(name, destination);
        }
    }

    function areAddressesImported(
        bytes32[] calldata _names,
        address[] calldata _addresses
    ) external view returns (bool) {
        for (uint256 i = 0; i < _names.length; i++) {
            if (addresses[_names[i]] != _addresses[i]) {
                return false;
            }
        }
        return true;
    }

    function getAddress(bytes32 _name, string calldata _reason)
        external
        view
        override
        returns (address)
    {
        address _foundAddress = addresses[_name];
        require(_foundAddress != address(0), _reason);
        return _foundAddress;
    }

    function getAddress(bytes32 _name)
        external
        view
        override
        returns (address)
    {
        return addresses[_name];
    }
}