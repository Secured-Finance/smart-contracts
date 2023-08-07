// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

// interfaces
import {ILendingMarket} from "./interfaces/ILendingMarket.sol";
// libraries
import {Contracts} from "./libraries/Contracts.sol";
import {OrderBookUserLogic} from "./libraries/logics/OrderBookUserLogic.sol";
import {OrderBookOperationLogic} from "./libraries/logics/OrderBookOperationLogic.sol";
import {OrderBookCalculationLogic} from "./libraries/logics/OrderBookCalculationLogic.sol";
import {RoundingUint256} from "./libraries/math/RoundingUint256.sol";
import {FilledOrder, PartiallyFilledOrder} from "./libraries/OrderBookLib.sol";
// mixins
import {MixinAddressResolver} from "./mixins/MixinAddressResolver.sol";
// types
import {ProtocolTypes} from "./types/ProtocolTypes.sol";
// utils
import {Pausable} from "./utils/Pausable.sol";
import {Proxyable} from "./utils/Proxyable.sol";
// storages
import {LendingMarketStorage as Storage, ItayoseLog} from "./storages/LendingMarketStorage.sol";

/**
 * @notice Implements the module that allows lending market participants to create/cancel market orders,
 * and also provides a future value calculation module.
 *
 * For updates, this contract is basically called from `LendingMarketController.sol`instead of being called \
 * directly by the user.
 *
 * @dev The market orders is stored in structured red-black trees and doubly linked lists in each node.
 */
contract LendingMarket is ILendingMarket, MixinAddressResolver, Pausable, Proxyable {
    using RoundingUint256 for uint256;

    uint256 private constant PRE_ORDER_PERIOD = 7 days;
    uint256 private constant ITAYOSE_PERIOD = 1 hours;

    /**
     * @notice Modifier to make a function callable only by order maker.
     * @param _orderBookId The order book id
     * @param _user User's address
     * @param _orderId Market order id
     */
    modifier onlyMaker(
        uint8 _orderBookId,
        address _user,
        uint48 _orderId
    ) {
        (, , , address maker, , , ) = getOrder(_orderBookId, _orderId);
        require(maker != address(0), "Order not found");
        require(_user == maker, "Caller is not the maker");
        _;
    }

    /**
     * @notice Modifier to check if the market is opened.
     * @param _orderBookId The order book id
     */
    modifier ifOpened(uint8 _orderBookId) {
        require(isOpened(_orderBookId), "Market is not opened");
        _;
    }

    /**
     * @notice Modifier to check if the market is under the Itayose period.
     * @param _orderBookId The order book id
     */
    modifier ifItayosePeriod(uint8 _orderBookId) {
        require(isItayosePeriod(_orderBookId), "Not in the Itayose period");
        _;
    }

    /**
     * @notice Modifier to check if the market is under the pre-order period.
     * @param _orderBookId The order book id
     */
    modifier ifPreOrderPeriod(uint8 _orderBookId) {
        require(isPreOrderPeriod(_orderBookId), "Not in the pre-order period");
        _;
    }

    /**
     * @notice Initializes the contract.
     * @dev Function is invoked by the proxy contract when the contract is added to the ProxyController.
     * @param _resolver The address of the Address Resolver contract
     * @param _ccy The main currency for the order book
     */
    function initialize(address _resolver, bytes32 _ccy) public initializer onlyBeacon {
        registerAddressResolver(_resolver);
        Storage.slot().ccy = _ccy;

        buildCache();
    }

    // @inheritdoc MixinAddressResolver
    function requiredContracts() public pure override returns (bytes32[] memory contracts) {
        contracts = new bytes32[](1);
        contracts[0] = Contracts.LENDING_MARKET_CONTROLLER;
    }

    // @inheritdoc MixinAddressResolver
    function acceptedContracts() public pure override returns (bytes32[] memory contracts) {
        contracts = new bytes32[](1);
        contracts[0] = Contracts.LENDING_MARKET_CONTROLLER;
    }

    /**
     * @notice Gets the order book data.
     * @param _orderBookId The order book id
     * @return market The market data
     */
    function getOrderBookDetail(uint8 _orderBookId)
        public
        view
        override
        returns (OrderBook memory market)
    {
        (
            market.ccy,
            market.maturity,
            market.openingDate,
            market.borrowUnitPrice,
            market.lendUnitPrice,
            market.midUnitPrice,
            market.openingUnitPrice,
            market.isReady
        ) = OrderBookOperationLogic.getOrderBookDetail(_orderBookId);
    }

    /**
     * @notice Gets unit price Thresholds by CircuitBreaker.
     * @param _orderBookId The order book id
     * @param _circuitBreakerLimitRange Rate limit range for the circuit breaker
     * @return maxLendUnitPrice The maximum unit price for lending
     * @return minBorrowUnitPrice The minimum unit price for borrowing
     */
    function getCircuitBreakerThresholds(uint8 _orderBookId, uint256 _circuitBreakerLimitRange)
        external
        view
        override
        returns (uint256 maxLendUnitPrice, uint256 minBorrowUnitPrice)
    {
        return
            OrderBookOperationLogic.getCircuitBreakerThresholds(
                _orderBookId,
                _circuitBreakerLimitRange
            );
    }

    /**
     * @notice Gets the best price for lending.
     * @param _orderBookId The order book id
     * @return The best price for lending
     */
    function getBestLendUnitPrice(uint8 _orderBookId) public view override returns (uint256) {
        return OrderBookOperationLogic.getBestLendUnitPrice(_orderBookId);
    }

    /**
     * @notice Gets the best prices for lending.
     * @return The array of the best price for lending
     */
    function getBestLendUnitPrices(uint8[] memory _orderBookIds)
        external
        view
        override
        returns (uint256[] memory)
    {
        return OrderBookOperationLogic.getBestLendUnitPrices(_orderBookIds);
    }

    /**
     * @notice Gets the best price for borrowing.
     * @param _orderBookId The order book id
     * @return The best price for borrowing
     */
    function getBestBorrowUnitPrice(uint8 _orderBookId) public view override returns (uint256) {
        return OrderBookOperationLogic.getBestBorrowUnitPrice(_orderBookId);
    }

    /**
     * @notice Gets the best prices for borrowing.
     * @return The array of the best price for borrowing
     */
    function getBestBorrowUnitPrices(uint8[] memory _orderBookIds)
        external
        view
        override
        returns (uint256[] memory)
    {
        return OrderBookOperationLogic.getBestBorrowUnitPrices(_orderBookIds);
    }

    /**
     * @notice Gets the mid price per future value.
     * @param _orderBookId The order book id
     * @return The mid price per future value
     */
    function getMidUnitPrice(uint8 _orderBookId) public view override returns (uint256) {
        return OrderBookOperationLogic.getMidUnitPrice(_orderBookId);
    }

    /**
     * @notice Gets the the prices per future value.
     * @return The array of the the price per future value
     */
    function getMidUnitPrices(uint8[] memory _orderBookIds)
        public
        view
        override
        returns (uint256[] memory)
    {
        return OrderBookOperationLogic.getMidUnitPrices(_orderBookIds);
    }

    /**
     * @notice Gets the order book of borrow.
     * @param _orderBookId The order book id
     * @param _limit Max limit to get unit prices
     * @return unitPrices The array of borrow unit prices
     */
    function getBorrowOrderBook(uint8 _orderBookId, uint256 _limit)
        external
        view
        override
        returns (
            uint256[] memory unitPrices,
            uint256[] memory amounts,
            uint256[] memory quantities
        )
    {
        return OrderBookOperationLogic.getBorrowOrderBook(_orderBookId, _limit);
    }

    /**
     * @notice Gets the order book of lend.
     * @param _orderBookId The order book id
     * @param _limit Max limit to get unit prices
     * @return unitPrices The array of lending unit prices
     */
    function getLendOrderBook(uint8 _orderBookId, uint256 _limit)
        external
        view
        override
        returns (
            uint256[] memory unitPrices,
            uint256[] memory amounts,
            uint256[] memory quantities
        )
    {
        return OrderBookOperationLogic.getLendOrderBook(_orderBookId, _limit);
    }

    /**
     * @notice Gets the current market maturity.
     * @param _orderBookId The order book id
     * @return maturity The market maturity
     */
    function getMaturity(uint8 _orderBookId) public view override returns (uint256 maturity) {
        return Storage.slot().orderBooks[_orderBookId].maturity;
    }

    /**
     * @notice Gets the order book maturities.
     * @return maturities The array of maturity
     */
    function getMaturities(uint8[] memory _orderBookIds)
        external
        view
        override
        returns (uint256[] memory maturities)
    {
        return OrderBookOperationLogic.getMaturities(_orderBookIds);
    }

    /**
     * @notice Gets the market currency.
     * @return currency The market currency
     */
    function getCurrency() external view override returns (bytes32 currency) {
        return Storage.slot().ccy;
    }

    /**
     * @notice Gets the market opening date.
     * @param _orderBookId The order book id
     * @return openingDate The market opening date
     */
    function getOpeningDate(uint8 _orderBookId) public view override returns (uint256 openingDate) {
        return Storage.slot().orderBooks[_orderBookId].openingDate;
    }

    /**
     * @notice Gets if the market is ready.
     * @param _orderBookId The order book id
     * @return The boolean if the market is ready or not
     */
    function isReady(uint8 _orderBookId) public view override returns (bool) {
        return Storage.slot().isReady[getMaturity(_orderBookId)];
    }

    /**
     * @notice Gets if the market is matured.
     * @param _orderBookId The order book id
     * @return The boolean if the market is matured or not
     */
    function isMatured(uint8 _orderBookId) public view override returns (bool) {
        return OrderBookCalculationLogic.isMatured(_orderBookId);
    }

    /**
     * @notice Gets if the market is opened.
     * @param _orderBookId The order book id
     * @return The boolean if the market is opened or not
     */
    function isOpened(uint8 _orderBookId) public view override returns (bool) {
        return
            isReady(_orderBookId) &&
            !isMatured(_orderBookId) &&
            block.timestamp >= getOpeningDate(_orderBookId);
    }

    /**
     * @notice Gets if the market is under the Itayose period.
     * @param _orderBookId The order book id
     * @return The boolean if the market is under the Itayose period.
     */
    function isItayosePeriod(uint8 _orderBookId) public view returns (bool) {
        return
            block.timestamp >= (getOpeningDate(_orderBookId) - ITAYOSE_PERIOD) &&
            !isReady(_orderBookId);
    }

    /**
     * @notice Gets if the market is under the pre-order period.
     * @param _orderBookId The order book id
     * @return The boolean if the market is under the pre-order period.
     */
    function isPreOrderPeriod(uint8 _orderBookId) public view override returns (bool) {
        uint256 openingDate = getOpeningDate(_orderBookId);
        return
            block.timestamp >= (openingDate - PRE_ORDER_PERIOD) &&
            block.timestamp < (openingDate - ITAYOSE_PERIOD);
    }

    /**
     * @notice Gets the market itayose logs.
     * @param _maturity The market maturity
     * @return ItayoseLog of the market
     */
    function getItayoseLog(uint256 _maturity) external view override returns (ItayoseLog memory) {
        return Storage.slot().itayoseLogs[_maturity];
    }

    /**
     * @notice Gets the market order from the order book.
     * @param _orderBookId The order book id
     * @param _orderId The market order id
     * @return side Order position type, Borrow or Lend
     * @return unitPrice Amount of interest unit price
     * @return maturity The maturity of the selected order
     * @return maker The order maker
     * @return amount Order amount
     * @return timestamp Timestamp when the order was created
     * @return isPreOrder The boolean if the order is a pre-order.
     */
    function getOrder(uint8 _orderBookId, uint48 _orderId)
        public
        view
        override
        returns (
            ProtocolTypes.Side side,
            uint256 unitPrice,
            uint256 maturity,
            address maker,
            uint256 amount,
            uint256 timestamp,
            bool isPreOrder
        )
    {
        return OrderBookCalculationLogic.getOrder(_orderBookId, _orderId);
    }

    /**
     * @notice Calculates and gets the active and inactive amounts from the user orders of lending deals.
     * @param _orderBookId The order book id
     * @param _user User's address
     * @return activeAmount The total amount of active order on the order book
     * @return inactiveAmount The total amount of inactive orders filled on the order book
     * @return inactiveFutureValue The total future value amount of inactive orders filled on the order book
     * @return maturity The maturity of market that orders were placed.
     */
    function getTotalAmountFromLendOrders(uint8 _orderBookId, address _user)
        external
        view
        override
        returns (
            uint256 activeAmount,
            uint256 inactiveAmount,
            uint256 inactiveFutureValue,
            uint256 maturity
        )
    {
        return OrderBookCalculationLogic.getTotalAmountFromLendOrders(_orderBookId, _user);
    }

    /**
     * @notice Calculates and gets the active and inactive amounts from the user orders of borrowing deals.
     * @param _orderBookId The order book id
     * @param _user User's address
     * @return activeAmount The total amount of active order on the order book
     * @return inactiveAmount The total amount of inactive orders filled on the order book
     * @return inactiveFutureValue The total future value amount of inactive orders filled on the order book
     * @return maturity The maturity of market that orders were placed.
     */
    function getTotalAmountFromBorrowOrders(uint8 _orderBookId, address _user)
        external
        view
        override
        returns (
            uint256 activeAmount,
            uint256 inactiveAmount,
            uint256 inactiveFutureValue,
            uint256 maturity
        )
    {
        return OrderBookCalculationLogic.getTotalAmountFromBorrowOrders(_orderBookId, _user);
    }

    /**
     * @notice Gets active and inactive order IDs in the lending order book.
     * @param _orderBookId The order book id
     * @param _user User's address
     */
    function getLendOrderIds(uint8 _orderBookId, address _user)
        external
        view
        override
        returns (uint48[] memory activeOrderIds, uint48[] memory inActiveOrderIds)
    {
        return OrderBookCalculationLogic.getLendOrderIds(_orderBookId, _user);
    }

    /**
     * @notice Gets active and inactive order IDs in the borrowing order book.
     * @param _orderBookId The order book id
     * @param _user User's address
     */
    function getBorrowOrderIds(uint8 _orderBookId, address _user)
        external
        view
        override
        returns (uint48[] memory activeOrderIds, uint48[] memory inActiveOrderIds)
    {
        return OrderBookCalculationLogic.getBorrowOrderIds(_orderBookId, _user);
    }

    /**
     * @notice Calculates the amount to be filled when executing an order in the order book.
     * @param _orderBookId The order book id
     * @param _side Order position type, Borrow or Lend
     * @param _amount Amount of funds the user wants to borrow/lend
     * @param _unitPrice Unit price user want to borrow/lend
     * @param _circuitBreakerLimitRange Rate limit range for the circuit breaker
     * @return lastUnitPrice The last unit price that is filled on the order book
     * @return filledAmount The amount that is filled on the order book
     * @return filledAmountInFV The amount in the future value that is filled on the order book
     */
    function calculateFilledAmount(
        uint8 _orderBookId,
        ProtocolTypes.Side _side,
        uint256 _amount,
        uint256 _unitPrice,
        uint256 _circuitBreakerLimitRange
    )
        external
        view
        override
        returns (
            uint256 lastUnitPrice,
            uint256 filledAmount,
            uint256 filledAmountInFV
        )
    {
        return
            OrderBookCalculationLogic.calculateFilledAmount(
                _orderBookId,
                _side,
                _amount,
                _unitPrice,
                _circuitBreakerLimitRange
            );
    }

    /**
     * @notice Creates a new order book.
     * @param _maturity The initial maturity of the market
     * @param _openingDate The timestamp when the market opens
     */
    function createOrderBook(uint256 _maturity, uint256 _openingDate)
        external
        override
        onlyAcceptedContracts
        returns (uint8 orderBookId)
    {
        return OrderBookOperationLogic.createOrderBook(_maturity, _openingDate);
    }

    function reopenOrderBook(
        uint8 _orderBookId,
        uint256 _newMaturity,
        uint256 _openingDate
    ) external override onlyAcceptedContracts {
        OrderBookOperationLogic.reopenOrderBook(_orderBookId, _newMaturity, _openingDate);
    }

    /**
     * @notice Cancels the order.
     * @param _orderBookId The order book id
     * @param _user User address
     * @param _orderId Market order id
     */
    function cancelOrder(
        uint8 _orderBookId,
        address _user,
        uint48 _orderId
    )
        external
        override
        onlyMaker(_orderBookId, _user, _orderId)
        whenNotPaused
        onlyAcceptedContracts
    {
        OrderBookUserLogic.cancelOrder(_orderBookId, _user, _orderId);
    }

    /**
     * @notice Cleans up own orders to remove order ids that are already filled on the order book.
     * @dev The order list per user is not updated in real-time when an order is filled.
     * This function removes the filled order from that order list per user to reduce gas costs
     * for lazy evaluation if the collateral is enough or not.
     *
     * @param _user User address
     * @return activeLendOrderCount The total amount of active lend order on the order book
     * @return activeBorrowOrderCount The total amount of active borrow order on the order book
     * @return removedLendOrderFutureValue The total FV amount of the removed lend order amount from the order book
     * @return removedBorrowOrderFutureValue The total FV amount of the removed borrow order amount from the order book
     * @return removedLendOrderAmount The total PV amount of the removed lend order amount from the order book
     * @return removedBorrowOrderAmount The total PV amount of the removed borrow order amount from the order book
     * @return maturity The maturity of the removed orders
     */
    function cleanUpOrders(uint8 _orderBookId, address _user)
        external
        override
        returns (
            uint256 activeLendOrderCount,
            uint256 activeBorrowOrderCount,
            uint256 removedLendOrderFutureValue,
            uint256 removedBorrowOrderFutureValue,
            uint256 removedLendOrderAmount,
            uint256 removedBorrowOrderAmount,
            uint256 maturity
        )
    {
        return OrderBookUserLogic.cleanUpOrders(_orderBookId, _user);
    }

    /**
     * @notice Executes an order. Takes orders if the order is matched,
     * and places new order if not match it.
     * @param _orderBookId The order book id
     * @param _side Order position type, Borrow or Lend
     * @param _user User's address
     * @param _amount Amount of funds the user wants to borrow/lend
     * @param _unitPrice Unit price user wish to borrow/lend
     * @param _circuitBreakerLimitRange Rate limit range for the circuit breaker
     * @return filledOrder User's Filled order of the user
     * @return partiallyFilledOrder Partially filled order on the order book
     */
    function executeOrder(
        uint8 _orderBookId,
        ProtocolTypes.Side _side,
        address _user,
        uint256 _amount,
        uint256 _unitPrice,
        uint256 _circuitBreakerLimitRange
    )
        external
        override
        whenNotPaused
        onlyAcceptedContracts
        ifOpened(_orderBookId)
        returns (FilledOrder memory filledOrder, PartiallyFilledOrder memory partiallyFilledOrder)
    {
        return
            OrderBookUserLogic.executeOrder(
                _orderBookId,
                _side,
                _user,
                _amount,
                _unitPrice,
                _circuitBreakerLimitRange
            );
    }

    /**
     * @notice Executes a pre-order. A pre-order will only be accepted from 168 hours (7 days) to 1 hour
     * before the market opens (Pre-order period). At the end of this period, Itayose will be executed.
     *
     * @param _orderBookId The order book id
     * @param _side Order position type, Borrow or Lend
     * @param _amount Amount of funds the maker wants to borrow/lend
     * @param _unitPrice Unit price taker wish to borrow/lend
     */
    function executePreOrder(
        uint8 _orderBookId,
        ProtocolTypes.Side _side,
        address _user,
        uint256 _amount,
        uint256 _unitPrice
    ) external override whenNotPaused onlyAcceptedContracts ifPreOrderPeriod(_orderBookId) {
        OrderBookUserLogic.executePreOrder(_orderBookId, _side, _user, _amount, _unitPrice);
    }

    /**
     * @notice Unwinds lending or borrowing positions by a specified future value amount.
     * @param _orderBookId The order book id
     * @param _side Order position type, Borrow or Lend
     * @param _user User's address
     * @param _futureValue Amount of future value unwound
     * @param _circuitBreakerLimitRange Rate limit range for the circuit breaker
     * @return filledOrder User's Filled order of the user
     * @return partiallyFilledOrder Partially filled order
     */
    function unwindPosition(
        uint8 _orderBookId,
        ProtocolTypes.Side _side,
        address _user,
        uint256 _futureValue,
        uint256 _circuitBreakerLimitRange
    )
        external
        override
        whenNotPaused
        onlyAcceptedContracts
        ifOpened(_orderBookId)
        returns (FilledOrder memory filledOrder, PartiallyFilledOrder memory partiallyFilledOrder)
    {
        return
            OrderBookUserLogic.unwindPosition(
                _orderBookId,
                _side,
                _user,
                _futureValue,
                _circuitBreakerLimitRange
            );
    }

    /**
     * @notice Executes Itayose to aggregate pre-orders and determine the opening unit price.
     * After this action, the market opens.
     * @dev If the opening date had already passed when this contract was created, this Itayose need not be executed.
     * @param _orderBookId The order book id
     * @return openingUnitPrice The opening price when Itayose is executed
     * @return totalOffsetAmount The total filled amount when Itayose is executed
     * @return openingDate The timestamp when the market opens
     * @return partiallyFilledLendingOrder Partially filled lending order on the order book
     * @return partiallyFilledBorrowingOrder Partially filled borrowing order on the order book
     */
    function executeItayoseCall(uint8 _orderBookId)
        external
        override
        whenNotPaused
        onlyAcceptedContracts
        ifItayosePeriod(_orderBookId)
        returns (
            uint256 openingUnitPrice,
            uint256 totalOffsetAmount,
            uint256 openingDate,
            PartiallyFilledOrder memory partiallyFilledLendingOrder,
            PartiallyFilledOrder memory partiallyFilledBorrowingOrder
        )
    {
        return OrderBookOperationLogic.executeItayoseCall(_orderBookId);
    }

    /**
     * @notice Pauses the lending market.
     */
    function pauseMarket() external override onlyAcceptedContracts {
        _pause();
    }

    /**
     * @notice Unpauses the lending market.
     */
    function unpauseMarket() external override onlyAcceptedContracts {
        _unpause();
    }
}
