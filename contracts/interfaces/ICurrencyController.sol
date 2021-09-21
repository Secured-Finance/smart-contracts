// SPDX-License-Identifier: MIT
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

/**
 * @dev Currency Controller contract is responsible for managing supported 
 * currencies in Secured Finance Protocol
 *
 * Contract links new currencies to ETH Chainlink price feeds, without existing price feed 
 * contract owner is not able to add a new currency into the protocol
 * 
 * Currency controller contract copies the logic of FXRatesAggregator contract, and 
 * will replace that contract in connection with Collateral Aggregator
 */
interface ICurrencyController {
    
    event CcyAdded(bytes32 indexed ccy, string name, uint8 chainId, uint256 ltv);
    event CcyCollateralUpdate(bytes32 indexed ccy, bool isCollateral);
    event CcySupportUpdate(bytes32 indexed ccy, bool isSupported);
    event LTVUpdated(bytes32 indexed ccy, uint256 ltv);
    event MinMarginUpdated(bytes32 indexed ccy, uint256 minMargin);
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);
    event PriceFeedAdded(bytes32 ccy, string secondCcy, address indexed priceFeed);
    event PriceFeedRemoved(bytes32 ccy, string secondCcy, address indexed priceFeed);

    function convertBulkToETH(bytes32 _ccy, uint256[] memory _amounts) external view returns (uint256[] memory);
    function convertToETH(bytes32 _ccy, uint256 _amount) external view returns (uint256);
    function currencies(bytes32) external view returns (bool isSupported, string memory name, uint8 chainId);
    function ethDecimals(bytes32) external view returns (uint8);
    function ethPriceFeeds(bytes32) external view returns (address);
    function getHistoricalETHPrice(bytes32 _ccy, uint80 _roundId) external view returns (int256);
    function getHistoricalUSDPrice(bytes32 _ccy, uint80 _roundId) external view returns (int256);
    function getLTV(bytes32 _ccy) external view returns (uint256);
    function getLastETHPrice(bytes32 _ccy) external view returns (int256);
    function getLastUSDPrice(bytes32 _ccy) external view returns (int256);
    function getMinMargin(bytes32 _ccy) external view returns (uint256);
    function isCollateral(bytes32) external view returns (bool);
    function isSupportedCcy(bytes32 _ccy) external view returns (bool);
    function last_ccy_index() external view returns (uint8);
    function linkPriceFeed(bytes32 _ccy, address _priceFeedAddr, bool _isEthPriceFeed) external returns (bool);
    function ltvs(bytes32) external view returns (uint256);
    function minMargins(bytes32) external view returns (uint256);
    function owner() external view returns (address);
    function removePriceFeed(bytes32 _ccy, bool _isEthPriceFeed) external;
    function setOwner(address _owner) external;
    function supportCurrency(bytes32 _ccy, string memory _name, uint8 _chainId, address _ethPriceFeed,uint256 _ltv) external returns (bool);
    function supportedCurrencies() external view returns (uint8);
    function updateCcyLTV(bytes32 _ccy, uint256 _ltv) external returns (bool);
    function updateCollateralSupport(bytes32 _ccy, bool _isSupported) external returns (bool);
    function updateCurrencySupport(bytes32 _ccy, bool _isSupported) external returns (bool);
    function updateMinMargin(bytes32 _ccy, uint256 _minMargin) external returns (bool);
    function usdDecimals(bytes32) external view returns (uint8);
    function usdPriceFeeds(bytes32) external view returns (address);
}