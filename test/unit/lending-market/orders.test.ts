import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { time } from '@openzeppelin/test-helpers';
import { expect } from 'chai';
import { MockContract } from 'ethereum-waffle';
import { Contract } from 'ethers';
import { ethers } from 'hardhat';
import moment from 'moment';

import { Side } from '../../../utils/constants';

import { calculateFutureValue } from '../../common/orders';
import { deployContracts } from './utils';

describe('LendingMarket - Orders', () => {
  let mockCurrencyController: MockContract;
  let lendingMarketCaller: Contract;
  let lendingMarket: Contract;

  let targetCurrency: string;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  let orderActionLogic: Contract;
  let currentMaturity: number;

  const deployOrderBook = async (maturity: number, openingDate: number) => {
    await lendingMarketCaller.createOrderBook(
      targetCurrency,
      maturity,
      openingDate,
      openingDate - 604800,
    );
  };

  before(async () => {
    [owner, alice, bob] = await ethers.getSigners();
    targetCurrency = ethers.utils.formatBytes32String('Test');

    ({
      mockCurrencyController,
      lendingMarketCaller,
      lendingMarket,
      orderActionLogic,
    } = await deployContracts(owner, targetCurrency));

    await mockCurrencyController.mock[
      'convertFromBaseCurrency(bytes32,uint256)'
    ].returns('100000');
  });

  describe('Check the block unit price', async () => {
    beforeEach(async () => {
      const { timestamp } = await ethers.provider.getBlock('latest');
      currentMaturity = moment(timestamp * 1000)
        .add(1, 'M')
        .unix();
      const openingDate = moment(timestamp * 1000).unix();

      await deployOrderBook(currentMaturity, openingDate);
    });

    afterEach(async () => {
      const isAutomine = await ethers.provider.send('hardhat_getAutomine', []);

      if (!isAutomine) {
        await ethers.provider.send('evm_setAutomine', [true]);
      }
    });

    const fillOrder = async (amount: string, unitPrice: string) => {
      // Note: In coverage tests, the `executeOrder` function fails due to the `out of gas` error.
      // To avoid this, we estimate the gas limit and set it to double.
      const estimations = await Promise.all([
        lendingMarketCaller.estimateGas.executeOrder(
          targetCurrency,
          currentMaturity,
          Side.LEND,
          amount,
          unitPrice,
        ),
        lendingMarketCaller.estimateGas.executeOrder(
          targetCurrency,
          currentMaturity,
          Side.BORROW,
          amount,
          unitPrice,
        ),
      ]);

      await lendingMarketCaller
        .connect(alice)
        .executeOrder(
          targetCurrency,
          currentMaturity,
          Side.LEND,
          amount,
          unitPrice,
          { gasLimit: estimations[0].mul(2) },
        );

      const tx = await lendingMarketCaller
        .connect(bob)
        .executeOrder(
          targetCurrency,
          currentMaturity,
          Side.BORROW,
          amount,
          unitPrice,
          { gasLimit: estimations[1].mul(2) },
        );

      return tx;
    };

    const checkBlockUnitPrice = async (
      marketUnitPrice: string,
      blockUnitPriceAverage: string,
    ) => {
      expect(await lendingMarket.getMarketUnitPrice(currentMaturity)).to.equal(
        marketUnitPrice,
      );

      expect(
        await lendingMarket.getBlockUnitPriceAverage(currentMaturity, 5),
      ).to.equal(blockUnitPriceAverage);
    };

    const checkBlockUnitPriceHistory = async (unitPrices: string[]) => {
      const history = await lendingMarket.getBlockUnitPriceHistory(
        currentMaturity,
      );

      expect(history.unitPrices.length).to.equal(5);
      expect(history.unitPrices[0]).to.equal(unitPrices[0] || '0');
      expect(history.unitPrices[1]).to.equal(unitPrices[1] || '0');
      expect(history.unitPrices[2]).to.equal(unitPrices[2] || '0');
      expect(history.unitPrices[3]).to.equal(unitPrices[3] || '0');
      expect(history.unitPrices[4]).to.equal(unitPrices[4] || '0');
    };

    it('Check with a single order', async () => {
      const tx = await fillOrder('100000000000000', '8000');

      await checkBlockUnitPrice('8000', '8000');
      await checkBlockUnitPriceHistory(['8000']);

      const lastOrderTimestamp = await lendingMarket.getLastOrderTimestamp(
        currentMaturity,
      );

      await tx.wait();
      const { timestamp } = await ethers.provider.getBlock(tx.blockNumber);

      expect(timestamp).to.equal(lastOrderTimestamp);
    });

    it('Check with multiple orders in the same block', async () => {
      await ethers.provider.send('evm_setAutomine', [false]);

      await fillOrder('100000000000000', '8000');
      await fillOrder('200000000000000', '9000');

      await checkBlockUnitPrice('0', '0');

      await ethers.provider.send('evm_mine', []);

      await checkBlockUnitPrice('8640', '8640');
      await checkBlockUnitPriceHistory(['8640']);
    });

    it('Check with multiple orders in the different block', async () => {
      await fillOrder('100000000000000', '8000');
      await fillOrder('200000000000000', '9000');

      await checkBlockUnitPrice('9000', '8500');
      await checkBlockUnitPriceHistory(['9000', '8000']);
    });

    it('Check with 5 orders in the different block', async () => {
      await fillOrder('100000000000000', '8000');
      await fillOrder('200000000000000', '8100');
      await fillOrder('300000000000000', '8200');
      await fillOrder('400000000000000', '8300');
      await fillOrder('500000000000000', '8400');

      await checkBlockUnitPrice('8400', '8200');
      await checkBlockUnitPriceHistory([
        '8400',
        '8300',
        '8200',
        '8100',
        '8000',
      ]);
    });

    it('Check with over 5 orders in the different block', async () => {
      await fillOrder('100000000000000', '8000');
      await fillOrder('200000000000000', '8100');
      await fillOrder('300000000000000', '8200');
      await fillOrder('400000000000000', '8300');
      await fillOrder('500000000000000', '8400');
      await fillOrder('600000000000000', '8500');

      await checkBlockUnitPrice('8500', '8300');
      await checkBlockUnitPriceHistory([
        '8500',
        '8400',
        '8300',
        '8200',
        '8100',
      ]);
    });

    it('Check with unwinding', async () => {
      await fillOrder('100000000000000', '8000');
      await checkBlockUnitPrice('8000', '8000');

      await lendingMarketCaller
        .connect(bob)
        .executeOrder(
          targetCurrency,
          currentMaturity,
          Side.LEND,
          '150000000000000',
          '9000',
        );

      await lendingMarketCaller
        .connect(alice)
        .unwindPosition(
          targetCurrency,
          currentMaturity,
          Side.BORROW,
          calculateFutureValue('100000000000000', '8000'),
        );

      await checkBlockUnitPrice('9000', '8500');
    });

    it('Check with an order less than the reliable amount', async () => {
      await fillOrder('99999', '8000');
      await checkBlockUnitPrice('8000', '8000');

      await fillOrder('99999', '8100');
      await checkBlockUnitPrice('8000', '8000');

      await fillOrder('99999', '8200');
      await checkBlockUnitPrice('8000', '8000');
    });

    it('Check with an order equal to the reliable amount', async () => {
      await fillOrder('99999', '8000');
      await checkBlockUnitPrice('8000', '8000');

      await fillOrder('100000', '8300');
      await checkBlockUnitPrice('8300', '8150');
    });
  });

  describe('Execute orders', async () => {
    beforeEach(async () => {
      const { timestamp } = await ethers.provider.getBlock('latest');
      currentMaturity = moment(timestamp * 1000)
        .add(1, 'M')
        .unix();
      const openingDate = moment(timestamp * 1000).unix();

      await deployOrderBook(currentMaturity, openingDate);
    });

    it('Fail to create a order due to the matured order book', async () => {
      await time.increaseTo(currentMaturity);

      expect(await lendingMarket.isMatured(currentMaturity)).to.true;

      await expect(
        lendingMarketCaller.executeOrder(
          targetCurrency,
          currentMaturity,
          Side.LEND,
          '1',
          '8000',
        ),
      ).revertedWith('MarketNotOpened');
    });

    it('Fail to unwind the position due to the matured order book', async () => {
      await time.increaseTo(currentMaturity);

      expect(await lendingMarket.isMatured(currentMaturity)).to.true;

      await expect(
        lendingMarketCaller.unwindPosition(
          targetCurrency,
          currentMaturity,
          Side.LEND,
          '125000000000000',
        ),
      ).revertedWith('MarketNotOpened');
    });

    it('Fail to create an order due to invalid caller', async () => {
      await expect(
        lendingMarket.executeOrder(
          currentMaturity,
          Side.LEND,
          ethers.constants.AddressZero,
          '100000000000000',
          '8000',
        ),
      ).revertedWith('OnlyAcceptedContract("LendingMarketController")');
    });

    it('Fail to cancel the order due to invalid caller', async () => {
      await expect(
        lendingMarket.cancelOrder(
          currentMaturity,
          ethers.constants.AddressZero,
          1,
        ),
      ).revertedWith('OnlyAcceptedContract("LendingMarketController")');
    });

    it('Fail to unwind the position due to invalid caller', async () => {
      await expect(
        lendingMarket.unwindPosition(
          currentMaturity,
          Side.LEND,
          ethers.constants.AddressZero,
          '125000000000000',
        ),
      ).revertedWith('OnlyAcceptedContract("LendingMarketController")');
    });
  });

  describe('Execute pre-orders', async () => {
    beforeEach(async () => {
      const { timestamp } = await ethers.provider.getBlock('latest');
      currentMaturity = moment(timestamp * 1000)
        .add(1, 'M')
        .unix();
      const openingDate = moment(timestamp * 1000)
        .add(48, 'h')
        .unix();

      await deployOrderBook(currentMaturity, openingDate);
    });

    it('Fail to create a lending pre-order due to opposite order existing', async () => {
      await lendingMarketCaller
        .connect(alice)
        .executePreOrder(
          targetCurrency,
          currentMaturity,
          Side.BORROW,
          '1000000000000000',
          '8000',
        );

      await expect(
        lendingMarketCaller
          .connect(alice)
          .executePreOrder(
            targetCurrency,
            currentMaturity,
            Side.LEND,
            '1000000000000000',
            '8000',
          ),
      ).to.be.revertedWith('OppositeSideOrderExists');
    });

    it('Fail to create a borrowing pre-order due to opposite order existing', async () => {
      await lendingMarketCaller
        .connect(alice)
        .executePreOrder(
          targetCurrency,
          currentMaturity,
          Side.LEND,
          '1000000000000000',
          '8000',
        );

      await expect(
        lendingMarketCaller
          .connect(alice)
          .executePreOrder(
            targetCurrency,
            currentMaturity,
            Side.BORROW,
            '1000000000000000',
            '8000',
          ),
      ).to.be.revertedWith('OppositeSideOrderExists');
    });

    it('Fail to create a pre-order due to invalid caller', async () => {
      await expect(
        lendingMarket.executePreOrder(
          currentMaturity,
          Side.LEND,
          ethers.constants.AddressZero,
          '100000000000000',
          '8000',
        ),
      ).revertedWith('OnlyAcceptedContract("LendingMarketController")');
    });
  });

  describe('Clean up orders', async () => {
    beforeEach(async () => {
      const { timestamp } = await ethers.provider.getBlock('latest');
      currentMaturity = moment(timestamp * 1000)
        .add(1, 'M')
        .unix();
      const openingDate = moment(timestamp * 1000).unix();

      await deployOrderBook(currentMaturity, openingDate);
    });

    it('Clean up a lending order', async () => {
      await lendingMarketCaller
        .connect(alice)
        .executeOrder(
          targetCurrency,
          currentMaturity,
          Side.LEND,
          '100000000000000',
          '8000',
        );

      await lendingMarketCaller
        .connect(bob)
        .executeOrder(
          targetCurrency,
          currentMaturity,
          Side.BORROW,
          '100000000000000',
          '8000',
        );

      await expect(
        lendingMarketCaller.cleanUpOrders(
          targetCurrency,
          currentMaturity,
          alice.address,
        ),
      )
        .to.emit(orderActionLogic, 'OrdersCleaned')
        .withArgs(
          [1],
          alice.address,
          Side.LEND,
          targetCurrency,
          currentMaturity,
          '100000000000000',
          '125000000000000',
        );
    });

    it('Clean up a borrowing order', async () => {
      await lendingMarketCaller
        .connect(bob)
        .executeOrder(
          targetCurrency,
          currentMaturity,
          Side.BORROW,
          '100000000000000',
          '8000',
        );

      await lendingMarketCaller
        .connect(alice)
        .executeOrder(
          targetCurrency,
          currentMaturity,
          Side.LEND,
          '100000000000000',
          '8000',
        );

      await expect(
        lendingMarketCaller.cleanUpOrders(
          targetCurrency,
          currentMaturity,
          bob.address,
        ),
      )
        .to.emit(orderActionLogic, 'OrdersCleaned')
        .withArgs(
          [1],
          bob.address,
          Side.BORROW,
          targetCurrency,
          currentMaturity,
          '100000000000000',
          '125000000000000',
        );
    });

    it('Fail to clean up orders due to invalid caller', async () => {
      await expect(
        lendingMarket.cleanUpOrders(currentMaturity, alice.address),
      ).revertedWith('OnlyAcceptedContract("LendingMarketController")');
    });
  });
});
