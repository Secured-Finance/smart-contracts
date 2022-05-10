// SPDX-License-Identifier: MIT
// !! THIS FILE WAS AUTOGENERATED BY abi-to-sol v0.5.3. SEE SOURCE BELOW. !!
pragma solidity >=0.6.12 <=0.7.0;
pragma experimental ABIEncoderV2;

import "./IExternalAdapterTxResponse.sol";

interface ISettlementEngine {
    event CrosschainSettlementRequested(
        address payer,
        address receiver,
        uint16 chainId,
        uint256 timestamp,
        string txHash,
        bytes32 requestId
    );
    event CrosschainSettlementRequestFulfilled(
        string payer,
        string receiver,
        uint16 chainId,
        uint256 amount,
        uint256 timestamp,
        string txHash,
        bytes32 settlementId
    );
    event ExternalAdapterAdded(address indexed adapter, bytes32 ccy);
    event ExternalAdapterUpdated(address indexed adapter, bytes32 ccy);

    function addExternalAdapter(address _adapter, bytes32 _ccy) external;

    function externalAdapters(uint16) external view returns (address);

    function fullfillSettlementRequest(
        bytes32 _requestId,
        IExternalAdapterTxResponse.FulfillData calldata _txData,
        bytes32 _ccy
    ) external;

    function getVersion() external view returns (uint16);

    function owner() external view returns (address);

    function replaceExternalAdapter(address _adapter, bytes32 _ccy) external;

    function settlementRequests(bytes32)
        external
        view
        returns (
            address payer,
            address receiver,
            uint16 chainId,
            uint256 timestamp,
            string memory txHash
        );

    function verifyPayment(
        address _counterparty,
        bytes32 _ccy,
        uint256 _payment,
        uint256 _timestamp,
        string calldata _txHash
    ) external payable returns (bytes32);
}
