// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

interface IBeaconProxyController {
    event BeaconProxyCreated(
        bytes32 indexed id,
        address indexed proxyAddress,
        address indexed implementationAddress
    );

    event BeaconProxyUpdated(
        bytes32 indexed id,
        address indexed proxyAddress,
        address indexed newImplementationAddress,
        address oldImplementationAddress
    );

    function getBeaconProxyAddress(bytes32 beaconName) external view returns (address);

    function setFutureValueVaultImpl(address newImpl) external;

    function setLendingMarketImpl(address newImpl) external;

    function deployFutureValueVault() external returns (address futureValueVault);

    function deployLendingMarket(
        bytes32 _ccy,
        uint256 _genesisDate,
        uint256 _maturity
    ) external returns (address market);
}
