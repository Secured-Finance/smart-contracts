// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import {Currency} from "../storages/CurrencyControllerStorage.sol";

/**
 * @dev Currency Controller contract is responsible for managing supported
 * currencies in Secured Finance Protocol
 *
 * Contract links new currencies to ETH Chainlink price feeds, without existing price feed
 * contract owner is not able to add a new currency into the protocol
 */
interface ICurrencyController {
    event AddSupportCurrency(bytes32 indexed ccy, string name, uint256 haircut);
    event UpdateSupportCurrency(bytes32 indexed ccy, bool isSupported);

    event UpdateHaircut(bytes32 indexed ccy, uint256 haircut);

    event AddPriceFeed(bytes32 ccy, string secondCcy, address indexed priceFeed);
    event RemovePriceFeed(bytes32 ccy, string secondCcy, address indexed priceFeed);

    function convertFromETH(bytes32 _ccy, uint256 _amountETH)
        external
        view
        returns (uint256 amount);

    function convertToETH(bytes32 _ccy, uint256 _amount) external view returns (uint256 amount);

    function convertToETH(bytes32 _ccy, int256 _amount) external view returns (int256 amount);

    function convertToETH(bytes32 _ccy, uint256[] memory _amounts)
        external
        view
        returns (uint256[] memory amounts);

    function getCurrency(bytes32) external view returns (Currency memory);

    function getEthDecimals(bytes32) external view returns (uint8);

    function getUsdDecimals(bytes32) external view returns (uint8);

    function getHaircut(bytes32 _ccy) external view returns (uint256);

    function getHistoricalETHPrice(bytes32 _ccy, uint80 _roundId) external view returns (int256);

    function getHistoricalUSDPrice(bytes32 _ccy, uint80 _roundId) external view returns (int256);

    function getLastETHPrice(bytes32 _ccy) external view returns (int256);

    function getLastUSDPrice(bytes32 _ccy) external view returns (int256);

    function isSupportedCcy(bytes32 _ccy) external view returns (bool);

    function linkPriceFeed(
        bytes32 _ccy,
        address _priceFeedAddr,
        bool _isEthPriceFeed
    ) external returns (bool);

    function removePriceFeed(bytes32 _ccy, bool _isEthPriceFeed) external;

    function supportCurrency(
        bytes32 _ccy,
        string memory _name,
        address _ethPriceFeed,
        uint256 _haircut
    ) external;

    function updateHaircut(bytes32 _ccy, uint256 _haircut) external;

    function updateCurrencySupport(bytes32 _ccy, bool _isSupported) external;
}
