// SPDX-License-Identifier: MIT
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "./ProtocolTypes.sol";
import "./interfaces/ICrosschainAddressResolver.sol";
import "./interfaces/ICollateralAggregatorV2.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

contract CrosschainAddressResolver is ICrosschainAddressResolver {
    using SafeMath for uint256;

    address public owner;

    // Mapping for storing user cross-chain addresses
    mapping(address => mapping(uint256 => string)) _crosschainAddreses;

    // Contracts
    address collateralAggregator;

    /**
     * @dev Modifier to make a function callable only by contract owner.
     */
    modifier onlyOwner() {
        require(msg.sender == owner);
        _;
    }

    /**
     * @dev Modifier to make a function callable only by contract owner.
     */
    modifier onlyCollateralAggregator() {
        require(msg.sender == collateralAggregator);
        _;
    }

    /**
     * @dev Contract constructor function.
     *
     * @notice sets contract deployer as owner of this contract and connects to the collateral aggregator contract
     */
    constructor(address _collateralAggregator) public {
        owner = msg.sender;
        collateralAggregator = _collateralAggregator;
    }

    /**
     * @dev Trigers to register multiple cross-chain addresses per chainId for user
     * @param _user Secured Finance user ETH address
     * @param _chainIds Array of chain ID number
     * @param _addresses Array of the target blockchain addresses
     *
     * @notice This function triggers by the Collateral Aggregator while user is registered in a system
     *
     */
    function updateAddresses(
        address _user,
        uint256[] memory _chainIds,
        string[] memory _addresses
    ) public override onlyCollateralAggregator {
        require(_chainIds.length == _addresses.length, "Invalid input lengths");

        for (uint256 i = 0; i < _chainIds.length; i++) {
            _updateAddress(_user, _chainIds[i], _addresses[i]);
        }
    }

    /**
     * @dev Trigers to register cross-chain address per chainId by user
     * @param _chainId Chain ID number
     * @param _address Target blockchain address
     *
     * @notice This function triggers by the user, and stores addresses for `msg.sender`
     *
     */
    function updateAddress(uint256 _chainId, string memory _address)
        public
        override
    {
        _updateAddress(msg.sender, _chainId, _address);
    }

    /**
     * @dev Trigers to register cross-chain address per chainId by user
     * @param _user Secured Finance user ETH address
     * @param _chainId Chain ID number
     * @param _address Target blockchain address
     *
     * @notice This function triggers by the Collateral Aggregator while user is registered in a system
     *
     */
    function updateAddress(
        address _user,
        uint256 _chainId,
        string memory _address
    ) public override onlyCollateralAggregator {
        _updateAddress(_user, _chainId, _address);
    }

    /**
     * @dev Trigers to get target blockchain address for a specific user.
     * @param _user Ethereum address of the Secured Finance user
     * @param _user Chain ID number
     */
    function getUserAddress(address _user, uint256 _chainId)
        public
        view
        override
        returns (string memory)
    {
        return _crosschainAddreses[_user][_chainId];
    }

    /**
     * @dev Internal function to store cross-chain addresses for user by chainID
     * @param _user Secured Finance user ETH address
     * @param _chainId Chain ID number
     * @param _address Target blockchain address
     *
     */
    function _updateAddress(
        address _user,
        uint256 _chainId,
        string memory _address
    ) internal {
        _crosschainAddreses[_user][_chainId] = _address;
        emit UpdateAddress(_user, _chainId, _address);
    }
}