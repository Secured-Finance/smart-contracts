import { expect } from 'chai';
import { BigNumber, constants, Contract } from 'ethers';
import { artifacts } from 'hardhat';
import {
  borrowingLimitOrders,
  borrowingMarketOrders,
} from './borrowing-orders';
import { lendingLimitOrders, lendingMarketOrders } from './lending-orders';
const OrderStatisticsTree = artifacts.require(
  'HitchensOrderStatisticsTreeContract.sol',
);

let ost: Contract;

describe('OrderStatisticsTree - drop values', () => {
  const tests = [
    {
      label: 'Lending',
      method: 'dropValuesFromFirst',
      marketOrders: lendingMarketOrders,
      limitOrders: lendingLimitOrders,
    },
    {
      label: 'Borrowing',
      method: 'dropValuesFromLast',
      marketOrders: borrowingMarketOrders,
      limitOrders: borrowingLimitOrders,
    },
  ];

  beforeEach(async () => {
    ost = await OrderStatisticsTree.new();
  });

  for (const test of tests) {
    describe(`${test.label} market orders`, async () => {
      describe('Drop nodes from the tree by one action', async () => {
        for (const condition of test.marketOrders) {
          describe(condition.title, async () => {
            for (const input of condition.inputs) {
              it(`${input.title}: Target amount is ${input.targetAmount}`, async () => {
                console.group();

                for (const order of condition.orders) {
                  await ost.insertAmountValue(
                    order.rate,
                    order.orderId,
                    constants.AddressZero,
                    order.amount,
                  );
                }
                const totalAmountBefore = await getTotalAmount('<Before>');

                await ost[test.method](input.targetAmount, 0);
                const totalAmountAfter = await getTotalAmount('<After>');

                console.groupEnd();

                expect(
                  totalAmountBefore?.sub(totalAmountAfter).toNumber(),
                ).equal(input.droppedAmount);
              });
            }
          });
        }
      });

      describe('Drop nodes from the tree by multiple actions', async () => {
        for (const condition of test.marketOrders) {
          describe(condition.title, async () => {
            for (const input of condition.inputs) {
              it(`${input.title}: Target amount is ${input.targetAmount}`, async () => {
                console.group();

                for (const order of condition.orders) {
                  await ost.insertAmountValue(
                    order.rate,
                    order.orderId,
                    constants.AddressZero,
                    order.amount,
                  );
                }
                await getTotalAmount('<Before>');

                await ost[test.method](input.targetAmount / 2, 0);
                await getTotalAmount('<After data is dropped 1>');

                await ost[test.method](input.targetAmount / 2, 0);
                await getTotalAmount('<After data is dropped 2>');

                console.groupEnd();
              });
            }
          });
        }
      });

      describe('Drop nodes from the tree by repeated inserting and dropping', async () => {
        for (const condition of test.marketOrders) {
          describe(condition.title, async () => {
            for (const input of condition.inputs) {
              it(`${input.title}: Target amount is ${input.targetAmount}`, async () => {
                console.group();

                for (const order of condition.orders) {
                  await ost.insertAmountValue(
                    order.rate,
                    order.orderId,
                    constants.AddressZero,
                    order.amount,
                  );
                }
                const totalAmountBefore = await getTotalAmount('<Before>');

                await ost[test.method](input.targetAmount, 0);
                const totalAmountAfter1 = await getTotalAmount(
                  '<After data is dropped>',
                );

                expect(
                  totalAmountBefore?.sub(totalAmountAfter1).toNumber(),
                ).equal(input.droppedAmount);

                for (const order of condition.orders) {
                  await ost.insertAmountValue(
                    order.rate,
                    order.orderId,
                    constants.AddressZero,
                    order.amount,
                  );
                }
                const totalAmountAfter2 = await getTotalAmount(
                  '<After data is inserted again>',
                );

                await ost[test.method](input.targetAmount, 0);
                const totalAmountAfter3 = await getTotalAmount(
                  '<After data is dropped again>',
                );

                console.groupEnd();

                expect(
                  totalAmountAfter2?.sub(totalAmountAfter3).toNumber(),
                ).equal(input.droppedAmount);
              });
            }
          });
        }
      });
    });

    describe(`${test.label} limit orders`, async () => {
      describe('Drop nodes from the tree', async () => {
        for (const condition of test.limitOrders) {
          describe(condition.title, async () => {
            for (const input of condition.inputs) {
              const title = `${input.title}: Target amount is ${input.targetAmount}, Limit value ${input?.limitValue}`;

              it(title, async () => {
                console.group();

                for (const order of condition.orders) {
                  await ost.insertAmountValue(
                    order.rate,
                    order.orderId,
                    constants.AddressZero,
                    order.amount,
                  );
                }
                const totalAmountBefore = await getTotalAmount('<Before>');

                await ost[test.method](
                  input.targetAmount,
                  input?.limitValue || 0,
                );
                const totalAmountAfter = await getTotalAmount('<After>');

                console.groupEnd();

                expect(
                  totalAmountBefore?.sub(totalAmountAfter).toNumber(),
                ).equal(input.droppedAmount);
              });
            }
          });
        }
      });
    });
  }
});

async function getTotalAmount(msg?: string) {
  // msg && console.log(msg);

  let value = await ost.firstValue();
  let totalAmount = BigNumber.from(0);

  if (value.toString() === '0') {
    // console.table([{ value: 'No value found in the tree.' }]);
    return totalAmount;
  }

  let node = await ost.getNode(value);
  const nodes: any = [];

  while (value.toString() !== '0') {
    node = await ost.getNode(value);
    nodes.push({
      value: value.toString(),
      parent: node._parent.toString(),
      left: node._left.toString(),
      right: node._right.toString(),
      red: node._red,
      orderCounter: node._orderCounter.toString(),
      orderTotalAmount: node._orderTotalAmount.toString(),
    });

    value = await ost.nextValue(value);
    totalAmount = totalAmount.add(node._orderTotalAmount.toString());
  }

  // console.table(nodes);

  return totalAmount;
}
