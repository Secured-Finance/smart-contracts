// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

contract UpgradeabilityBeaconProxy is BeaconProxy {
    constructor(address _beacon, bytes memory _data) payable BeaconProxy(_beacon, _data) {
        _changeAdmin(msg.sender);
    }

    modifier ifAdmin() {
        if (msg.sender == _getAdmin()) {
            _;
        } else {
            _fallback();
        }
    }

    function upgradeTo(address newImplementation) external ifAdmin {
        _upgradeTo(newImplementation);
    }

    function changeAdmin(address newAdmin) external ifAdmin {
        _changeAdmin(newAdmin);
    }

    function admin() external view returns (address) {
        return _getAdmin();
    }

    function implementation() external view returns (address) {
        return BeaconProxy._implementation();
    }
}
