const FXMarket = artifacts.require('FXMarket');
const Collateral = artifacts.require('Collateral');
const OrderBook = artifacts.require('LendingMarket');
const Loan = artifacts.require('Loan');

const {Side, Ccy, Term, ColState, sample} = require('../test-utils').constants;
const {accounts, defaultSender, web3, provider} = require("@openzeppelin/test-environment");
const {
  toDate,
  printCol,
} = require('../test-utils/src/helper');
const {
  ONE_DAY,
  NOTICE_GAP,
  advanceTimeAndBlock,
  getLatestTimestamp,
} = require('../test-utils').time;
const { emitted, reverted } = require('../test-utils').assert;
const { orders } = require("./orders");

/* Helper */
const val = (obj) => {
    if (obj.addrFIL) obj.addrFIL = web3.utils.asciiToHex(obj.addrFIL);
    return Object.values(obj);
};  

const getDate = async () => {
  const currentTime = await getLatestTimestamp();
  return toDate(currentTime);
};

const effectiveSec = 60 * 60 * 24 * 14; // 14 days

const expectRevert = reverted;

contract('OrderBook', async (accounts) => {
  const [owner, alice, bob, carol] = accounts;
  const users = [alice, bob, carol]; // without owner

  let snapshotId;
  let fxMarket;
  let collateral;
  let loan;
  let orderBook;
  let orderList;

  before('deploy OrderBook', async () => {
    let time = await getLatestTimestamp();
    console.log('before    ', toDate(time));
    orderList = orders;

    fxMarket = await FXMarket.new();
    loan = await Loan.new();
    collateral = await Collateral.new(loan.address);
    await collateral.setFxMarketAddr(fxMarket.address, {from: owner});
    await loan.setCollateralAddr(collateral.address, {from: owner});
    
    orderBook = await OrderBook.new(Ccy.FIL, Term._1y, owner);
    await orderBook.setCollateral(collateral.address, {from: owner});
    await collateral.addLendingMarket(Ccy.FIL, Term._1y, orderBook.address, {from: owner});
    await loan.addLendingMarket(Ccy.FIL, Term._1y, orderBook.address, {from: owner});
  });

  describe('Setup Test Data', async () => {
    it('Init Collateral with sample data', async () => {
      sample.Collateral.forEach(async (item, index) => {
        let res = await collateral.setColBook(...val(item), {
          from: users[index],
          // value: 0,
          value: 100000,
        });
        await emitted(res, 'SetColBook');
      });
    });
    it('Init with sample FXMarket', async () => {
      sample.FXMarket.forEach(async (item) => {
        let res = await fxMarket.setFXBook(...val(item), {from: alice});
        await emitted(res, 'SetFXBook');
      });
    });
    it('Create new market order by Alice', async () => {
      let marketOrder = await orderBook.order(0, 10000, 375, effectiveSec, {from: alice});
      await emitted(marketOrder, 'MakeOrder');
    });
    it('Take order successfully by Bob and insuficient amount by Carol', async () => {
        let marketOrder = await orderBook.order(1, 1000, 375, effectiveSec, {from: bob});
        await emitted(marketOrder, 'TakeOrder');

        let marketOrder2 = await orderBook.order(1, 15000, 375, effectiveSec, {from: carol});
        await emitted(marketOrder2, 'MakeOrder');
    });

    it('Cancel created order: revert for Bob and success for Alice', async () => {
        await expectRevert(
            orderBook.cancelOrder(1, {from: bob}),
            "No access to cancel order",
        );
        let marketOrder = await orderBook.cancelOrder(1, {from: alice});
        await emitted(marketOrder, 'CancelOrder');
    });
    it('Create new market order by Bob, and cancel on next day', async () => {
        let marketOrder = await orderBook.order(1, 1000, 750, effectiveSec, {from: bob});
        await emitted(marketOrder, 'MakeOrder');
        await advanceTimeAndBlock(ONE_DAY);
        let canceledOrder = await orderBook.cancelOrder(3, {from: bob});
        await emitted(canceledOrder, 'CancelOrder');
      });
    it('Create new market order by Bob, wait 15 days and try to take by Alice but cancel instead', async () => {
        let marketOrder = await orderBook.order(1, 1000, 750, effectiveSec, {from: bob});
        await emitted(marketOrder, 'MakeOrder');
        await advanceTimeAndBlock(NOTICE_GAP + ONE_DAY);

        let canceledOrder = await orderBook.order(0, 1000, 750, effectiveSec, {from: alice});
        await emitted(canceledOrder, 'CancelOrder');
      });

      it('Create 10 new market orders with the same interest rate', async () => {
        for(i=0; i < orderList.length; i++) {
          amount = orderList[i]["amount"];
          orderId = orderList[i]["orderId"];
          rate = orderList[i]["rate"];

          let marketOrder = await orderBook.order(0, amount, rate, effectiveSec, {from: bob});
          await emitted(marketOrder, 'MakeOrder');
        }
      });

      it('check market orders from linked list', async () => {
        for(i=0; i < orderList.length; i++) {
          amount = orderList[i]["amount"];
          orderId = orderList[i]["orderId"];
          rate = orderList[i]["rate"];

          const marketOrder = await orderBook.getOrderFromTree(0, rate, orderId);
          console.log("Order ID: " + marketOrder[0].toNumber());
          console.log("Next: " + marketOrder[1].toNumber());
          console.log("Prev: " + marketOrder[2].toNumber());
          console.log("Timestamp: " + marketOrder[3].toNumber());
          console.log("Amount: " + marketOrder[4].toNumber());

          console.log();
          }
      })

      it('Try to take 10 market orders with the same interest rate', async () => {
        for(i=0; i < orderList.length; i++) {
          amount = orderList[i]["amount"];
          orderId = orderList[i]["orderId"];
          rate = orderList[i]["rate"];

          let marketOrder = await orderBook.order(1, amount, rate, effectiveSec, {from: alice});
          await emitted(marketOrder, 'TakeOrder');
        }
      });

  });
});