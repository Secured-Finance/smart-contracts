// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import {OrderBookLib, FilledOrder, PartiallyFilledOrder} from "../OrderBookLib.sol";
import {Constants} from "../Constants.sol";
import {RoundingUint256} from "../math/RoundingUint256.sol";
import {ProtocolTypes} from "../../types/ProtocolTypes.sol";
import {LendingMarketStorage as Storage} from "../../storages/LendingMarketStorage.sol";
import {OrderReaderLogic} from "./OrderReaderLogic.sol";

library OrderActionLogic {
    using OrderBookLib for OrderBookLib.OrderBook;
    using RoundingUint256 for uint256;

    struct OrderExecutionConditions {
        bool isFilled;
        uint256 executedUnitPrice;
        bool ignoreRemainingAmount;
        bool orderExists;
    }

    struct PlacedOrder {
        uint48 orderId;
        uint256 amount;
        uint256 unitPrice;
    }

    struct ExecuteOrderVars {
        OrderExecutionConditions conditions;
        PlacedOrder placedOrder;
        bool isCircuitBreakerTriggered;
        uint256 maturity;
    }

    struct FillOrdersVars {
        uint8 orderBookId;
        uint256 remainingAmount;
        bool orderExists;
    }

    event OrderCanceled(
        uint48 orderId,
        address indexed maker,
        ProtocolTypes.Side side,
        bytes32 ccy,
        uint256 maturity,
        uint256 amount,
        uint256 unitPrice
    );

    event OrdersCleaned(
        uint48[] orderIds,
        address indexed maker,
        ProtocolTypes.Side side,
        bytes32 indexed ccy,
        uint256 maturity,
        uint256 amount,
        uint256 futureValue
    );

    event OrderExecuted(
        address indexed user,
        ProtocolTypes.Side side,
        bytes32 indexed ccy,
        uint256 indexed maturity,
        uint256 inputAmount,
        uint256 inputUnitPrice,
        uint256 filledAmount,
        uint256 filledUnitPrice,
        uint256 filledAmountInFV,
        uint256 feeInFV,
        uint48 placedOrderId,
        uint256 placedAmount,
        uint256 placedUnitPrice,
        bool isCircuitBreakerTriggered
    );

    event PreOrderExecuted(
        address indexed user,
        ProtocolTypes.Side side,
        bytes32 indexed ccy,
        uint256 indexed maturity,
        uint256 amount,
        uint256 unitPrice,
        uint48 orderId
    );

    event PositionUnwound(
        address indexed user,
        ProtocolTypes.Side side,
        bytes32 indexed ccy,
        uint256 indexed maturity,
        uint256 inputFutureValue,
        uint256 filledAmount,
        uint256 filledUnitPrice,
        uint256 filledAmountInFV,
        uint256 feeInFV,
        bool isCircuitBreakerTriggered
    );

    function cancelOrder(
        uint8 _orderBookId,
        address _user,
        uint48 _orderId
    ) external {
        OrderBookLib.OrderBook storage orderBook = _getOrderBook(_orderBookId);

        (ProtocolTypes.Side side, uint256 removedAmount, uint256 unitPrice) = orderBook.removeOrder(
            _user,
            _orderId
        );

        emit OrderCanceled(
            _orderId,
            _user,
            side,
            Storage.slot().ccy,
            orderBook.maturity,
            removedAmount,
            unitPrice
        );
    }

    function cleanUpOrders(uint8 _orderBookId, address _user)
        external
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
        OrderBookLib.OrderBook storage orderBook = _getOrderBook(_orderBookId);
        maturity = orderBook.userCurrentMaturities[_user];

        uint48[] memory lendOrderIds;
        uint48[] memory borrowOrderIds;

        (
            lendOrderIds,
            activeLendOrderCount,
            removedLendOrderFutureValue,
            removedLendOrderAmount
        ) = _cleanLendOrders(_orderBookId, _user);

        (
            borrowOrderIds,
            activeBorrowOrderCount,
            removedBorrowOrderFutureValue,
            removedBorrowOrderAmount
        ) = _cleanBorrowOrders(_orderBookId, _user);

        if (removedLendOrderAmount > 0) {
            emit OrdersCleaned(
                lendOrderIds,
                _user,
                ProtocolTypes.Side.LEND,
                Storage.slot().ccy,
                orderBook.maturity,
                removedLendOrderAmount,
                removedLendOrderFutureValue
            );
        }

        if (removedBorrowOrderAmount > 0) {
            emit OrdersCleaned(
                borrowOrderIds,
                _user,
                ProtocolTypes.Side.BORROW,
                Storage.slot().ccy,
                orderBook.maturity,
                removedBorrowOrderAmount,
                removedBorrowOrderFutureValue
            );
        }
    }

    function executeOrder(
        uint8 _orderBookId,
        ProtocolTypes.Side _side,
        address _user,
        uint256 _amount,
        uint256 _unitPrice
    )
        external
        returns (
            FilledOrder memory filledOrder,
            PartiallyFilledOrder memory partiallyFilledOrder,
            uint256 feeInFV
        )
    {
        require(_amount > 0, "Amount is zero");
        _updateUserMaturity(_orderBookId, _user);

        ExecuteOrderVars memory vars;

        OrderBookLib.OrderBook storage orderBook = _getOrderBook(_orderBookId);
        vars.maturity = orderBook.maturity;

        (
            vars.conditions.isFilled,
            vars.conditions.executedUnitPrice,
            vars.conditions.ignoreRemainingAmount,
            vars.conditions.orderExists
        ) = orderBook.getOrderExecutionConditions(
            _side,
            _unitPrice,
            Storage.slot().circuitBreakerLimitRange
        );

        if (vars.conditions.isFilled) {
            (
                filledOrder,
                partiallyFilledOrder,
                vars.placedOrder,
                vars.isCircuitBreakerTriggered
            ) = _fillOrders(
                _orderBookId,
                _side,
                _user,
                _amount,
                vars.conditions.executedUnitPrice,
                vars.conditions.ignoreRemainingAmount
            );
            feeInFV = OrderReaderLogic.calculateOrderFeeAmount(
                vars.maturity,
                filledOrder.futureValue
            );
        } else {
            if (!vars.conditions.ignoreRemainingAmount) {
                vars.placedOrder = PlacedOrder(
                    _placeOrder(
                        _orderBookId,
                        _side,
                        _user,
                        _amount,
                        vars.conditions.executedUnitPrice
                    ),
                    _amount,
                    vars.conditions.executedUnitPrice
                );
            }

            vars.isCircuitBreakerTriggered = _unitPrice == 0
                ? vars.conditions.orderExists
                : _unitPrice != vars.conditions.executedUnitPrice;
        }

        emit OrderExecuted(
            _user,
            _side,
            Storage.slot().ccy,
            vars.maturity,
            _amount,
            _unitPrice,
            filledOrder.amount,
            filledOrder.unitPrice,
            filledOrder.futureValue,
            feeInFV,
            vars.placedOrder.orderId,
            vars.placedOrder.amount,
            vars.placedOrder.unitPrice,
            vars.isCircuitBreakerTriggered
        );
    }

    function executePreOrder(
        uint8 _orderBookId,
        ProtocolTypes.Side _side,
        address _user,
        uint256 _amount,
        uint256 _unitPrice
    ) external {
        require(_amount > 0, "Amount is zero");

        _updateUserMaturity(_orderBookId, _user);
        OrderBookLib.OrderBook storage orderBook = _getOrderBook(_orderBookId);

        if (
            (_side == ProtocolTypes.Side.LEND && orderBook.hasBorrowOrder(_user)) ||
            (_side == ProtocolTypes.Side.BORROW && orderBook.hasLendOrder(_user))
        ) {
            revert("Opposite side order exists");
        }

        uint48 orderId = _placeOrder(_orderBookId, _side, _user, _amount, _unitPrice);
        orderBook.isPreOrder[orderId] = true;

        emit PreOrderExecuted(
            _user,
            _side,
            Storage.slot().ccy,
            orderBook.maturity,
            _amount,
            _unitPrice,
            orderId
        );
    }

    function unwindPosition(
        uint8 _orderBookId,
        ProtocolTypes.Side _side,
        address _user,
        uint256 _futureValue
    )
        external
        returns (
            FilledOrder memory filledOrder,
            PartiallyFilledOrder memory partiallyFilledOrder,
            uint256 feeInFV
        )
    {
        require(_futureValue > 0, "Can't place empty future value amount");

        OrderExecutionConditions memory conditions;
        bool isCircuitBreakerTriggered;
        OrderBookLib.OrderBook storage orderBook = _getOrderBook(_orderBookId);
        uint256 maturity = orderBook.maturity;

        (
            conditions.isFilled,
            conditions.executedUnitPrice,
            conditions.ignoreRemainingAmount,
            conditions.orderExists
        ) = orderBook.getOrderExecutionConditions(
            _side,
            0,
            Storage.slot().circuitBreakerLimitRange
        );

        if (conditions.isFilled) {
            (filledOrder, partiallyFilledOrder, isCircuitBreakerTriggered) = _unwindPosition(
                _orderBookId,
                _side,
                _futureValue,
                conditions.executedUnitPrice
            );
            feeInFV = OrderReaderLogic.calculateOrderFeeAmount(maturity, filledOrder.futureValue);
        } else {
            isCircuitBreakerTriggered = conditions.orderExists;
        }

        emit PositionUnwound(
            _user,
            _side,
            Storage.slot().ccy,
            maturity,
            _futureValue,
            filledOrder.amount,
            filledOrder.unitPrice,
            filledOrder.futureValue,
            feeInFV,
            isCircuitBreakerTriggered
        );
    }

    function _updateUserMaturity(uint8 _orderBookId, address _user) private {
        OrderBookLib.OrderBook storage orderBook = _getOrderBook(_orderBookId);
        uint256 userMaturity = orderBook.userCurrentMaturities[_user];
        require(
            userMaturity == orderBook.maturity ||
                (userMaturity != orderBook.maturity &&
                    orderBook.activeLendOrderIds[_user].length == 0 &&
                    orderBook.activeBorrowOrderIds[_user].length == 0),
            "Order found in past maturity"
        );

        if (userMaturity != orderBook.maturity) {
            orderBook.userCurrentMaturities[_user] = orderBook.maturity;
        }
    }

    function _cleanLendOrders(uint8 _orderBookId, address _user)
        internal
        returns (
            uint48[] memory orderIds,
            uint256 activeOrderCount,
            uint256 removedFutureValue,
            uint256 removedOrderAmount
        )
    {
        OrderBookLib.OrderBook storage orderBook = _getOrderBook(_orderBookId);

        (uint48[] memory activeLendOrderIds, uint48[] memory inActiveLendOrderIds) = orderBook
            .getLendOrderIds(_user);

        orderBook.activeLendOrderIds[_user] = activeLendOrderIds;
        activeOrderCount = activeLendOrderIds.length;
        uint256 inactiveOrderCount = inActiveLendOrderIds.length;
        orderIds = new uint48[](inactiveOrderCount);

        for (uint256 i = 0; i < inactiveOrderCount; i++) {
            (uint256 presentValue, uint256 futureValue) = OrderReaderLogic.getLendOrderAmounts(
                orderBook,
                inActiveLendOrderIds[i]
            );

            removedOrderAmount += presentValue;
            removedFutureValue += futureValue;
            orderIds[i] = inActiveLendOrderIds[i];
        }
    }

    function _cleanBorrowOrders(uint8 _orderBookId, address _user)
        internal
        returns (
            uint48[] memory orderIds,
            uint256 activeOrderCount,
            uint256 removedFutureValue,
            uint256 removedOrderAmount
        )
    {
        OrderBookLib.OrderBook storage orderBook = _getOrderBook(_orderBookId);

        (uint48[] memory activeBorrowOrderIds, uint48[] memory inActiveBorrowOrderIds) = orderBook
            .getBorrowOrderIds(_user);

        orderBook.activeBorrowOrderIds[_user] = activeBorrowOrderIds;
        activeOrderCount = activeBorrowOrderIds.length;
        uint256 inactiveOrderCount = inActiveBorrowOrderIds.length;
        orderIds = new uint48[](inactiveOrderCount);

        for (uint256 i = 0; i < inactiveOrderCount; i++) {
            (uint256 presentValue, uint256 futureValue) = OrderReaderLogic.getBorrowOrderAmounts(
                orderBook,
                inActiveBorrowOrderIds[i]
            );

            removedOrderAmount += presentValue;
            removedFutureValue += futureValue;
            orderIds[i] = inActiveBorrowOrderIds[i];
        }
    }

    /**
     * @notice Makes a new order in the order book.
     * @param _side Order position type, Borrow or Lend
     * @param _user User's address
     * @param _amount Amount of funds the maker wants to borrow/lend
     * @param _unitPrice Preferable interest unit price
     */
    function _placeOrder(
        uint8 _orderBookId,
        ProtocolTypes.Side _side,
        address _user,
        uint256 _amount,
        uint256 _unitPrice
    ) private returns (uint48 orderId) {
        orderId = _getOrderBook(_orderBookId).insertOrder(_side, _user, _amount, _unitPrice);
    }

    /**
     * @notice Takes orders in the order book.
     * @param _side Order position type, Borrow or Lend
     * @param _user User's address
     * @param _amount Amount of funds the maker wants to borrow/lend
     * @param _unitPrice Unit price taken
     * @param _ignoreRemainingAmount Boolean for whether to ignore the remaining amount after filling orders
     */
    function _fillOrders(
        uint8 _orderBookId,
        ProtocolTypes.Side _side,
        address _user,
        uint256 _amount,
        uint256 _unitPrice,
        bool _ignoreRemainingAmount
    )
        private
        returns (
            FilledOrder memory filledOrder,
            PartiallyFilledOrder memory partiallyFilledOrder,
            PlacedOrder memory placedOrder,
            bool isCircuitBreakerTriggered
        )
    {
        FillOrdersVars memory vars;
        vars.orderBookId = _orderBookId;

        (filledOrder, partiallyFilledOrder, vars.remainingAmount, vars.orderExists) = _getOrderBook(
            vars.orderBookId
        ).fillOrders(_side, _amount, 0, _unitPrice);

        filledOrder.amount = _amount - vars.remainingAmount;

        if (vars.remainingAmount > 0) {
            if (_ignoreRemainingAmount) {
                filledOrder.ignoredAmount = vars.remainingAmount;
            } else {
                // Make a new order for the remaining amount of input
                placedOrder = PlacedOrder(
                    _placeOrder(vars.orderBookId, _side, _user, vars.remainingAmount, _unitPrice),
                    vars.remainingAmount,
                    _unitPrice
                );
            }
        }

        isCircuitBreakerTriggered =
            vars.orderExists &&
            _ignoreRemainingAmount &&
            _amount != filledOrder.amount;
    }

    function _unwindPosition(
        uint8 _orderBookId,
        ProtocolTypes.Side _side,
        uint256 _futureValue,
        uint256 _unitPrice
    )
        private
        returns (
            FilledOrder memory filledOrder,
            PartiallyFilledOrder memory partiallyFilledOrder,
            bool isCircuitBreakerTriggered
        )
    {
        bool orderExists;
        uint256 futureValueWithFee;
        OrderBookLib.OrderBook storage orderBook = _getOrderBook(_orderBookId);
        uint256 maturity = orderBook.maturity;
        uint256 currentMaturity = maturity >= block.timestamp ? maturity - block.timestamp : 0;

        if (_side == ProtocolTypes.Side.BORROW) {
            // To unwind all positions, calculate the future value taking into account
            // the added portion of the fee.
            // NOTE: The formula is:
            // actualRate = feeRate * (currentMaturity / SECONDS_IN_YEAR)
            // amount = totalAmountInFV / (1 + actualRate)
            futureValueWithFee = (_futureValue * Constants.SECONDS_IN_YEAR * Constants.PCT_DIGIT)
                .div(
                    Constants.SECONDS_IN_YEAR *
                        Constants.PCT_DIGIT +
                        (Storage.slot().orderFeeRate * currentMaturity)
                );
        } else {
            // To unwind all positions, calculate the future value taking into account
            // the subtracted portion of the fee.
            // NOTE: The formula is:
            // actualRate = feeRate * (currentMaturity / SECONDS_IN_YEAR)
            // amount = totalAmountInFV / (1 - actualRate)
            futureValueWithFee = (_futureValue * Constants.SECONDS_IN_YEAR * Constants.PCT_DIGIT)
                .div(
                    Constants.SECONDS_IN_YEAR *
                        Constants.PCT_DIGIT -
                        (Storage.slot().orderFeeRate * currentMaturity)
                );
        }

        (filledOrder, partiallyFilledOrder, , orderExists) = orderBook.fillOrders(
            _side,
            0,
            futureValueWithFee,
            _unitPrice
        );

        isCircuitBreakerTriggered = orderExists && _futureValue != filledOrder.futureValue;
    }

    function _getOrderBook(uint8 _orderBookId)
        private
        view
        returns (OrderBookLib.OrderBook storage)
    {
        return Storage.slot().orderBooks[_orderBookId];
    }
}