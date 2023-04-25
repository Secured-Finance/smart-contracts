import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { time } from '@openzeppelin/test-helpers';
import BigNumberJS from 'bignumber.js';
import { expect } from 'chai';
import { BigNumber, Contract } from 'ethers';
import { ethers } from 'hardhat';

import { Side } from '../../utils/constants';
import { hexEFIL, hexETH } from '../../utils/strings';
import {
  AUTO_ROLL_FEE_RATE,
  LIQUIDATION_PROTOCOL_FEE_RATE,
  LIQUIDATION_THRESHOLD_RATE,
  LIQUIDATOR_FEE_RATE,
  PRICE_DIGIT,
} from '../common/constants';
import { deployContracts } from '../common/deployment';
import { formatOrdinals } from '../common/format';
import { Signers } from '../common/signers';

const BP = ethers.BigNumber.from(PRICE_DIGIT);

describe('Integration Test: Auto-rolls', async () => {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let dave: SignerWithAddress;

  let addressResolver: Contract;
  let futureValueVaults: Contract[];
  let genesisValueVault: Contract;
  let reserveFund: Contract;
  let tokenVault: Contract;
  let lendingMarketController: Contract;
  let lendingMarkets: Contract[] = [];
  let wETHToken: Contract;
  let eFILToken: Contract;

  let genesisDate: number;
  let maturities: BigNumber[];

  let signers: Signers;

  const initialFILBalance = BigNumber.from('100000000000000000000');

  const getUsers = async (count: number) =>
    signers.get(count, async (signer) => {
      await eFILToken
        .connect(owner)
        .transfer(signer.address, initialFILBalance);
    });

  const createSampleETHOrders = async (
    user: SignerWithAddress,
    maturity: BigNumber,
    unitPrice: string,
  ) => {
    await tokenVault.connect(user).deposit(hexETH, '3000000', {
      value: '3000000',
    });

    await lendingMarketController
      .connect(user)
      .createOrder(hexETH, maturity, Side.BORROW, '1000000', unitPrice);

    await lendingMarketController
      .connect(user)
      .createOrder(hexETH, maturity, Side.LEND, '1000000', unitPrice);
  };

  const executeAutoRoll = async (unitPrice?: string) => {
    if (unitPrice) {
      // Move to 6 hours (21600 sec) before maturity.
      await time.increaseTo(maturities[0].sub('21600').toString());
      // await createSampleETHOrders(carol, maturities[1], unitPrice);
      await createSampleETHOrders(owner, maturities[1], unitPrice);
    }
    await time.increaseTo(maturities[0].toString());
    await lendingMarketController.connect(owner).rotateLendingMarkets(hexETH);

    await lendingMarketController
      .connect(owner)
      .executeItayoseCalls([hexETH], maturities[maturities.length - 1]);
  };

  const resetContractInstances = async () => {
    maturities = await lendingMarketController.getMaturities(hexETH);
    [lendingMarkets, futureValueVaults] = await Promise.all([
      lendingMarketController
        .getLendingMarkets(hexETH)
        .then((addresses) =>
          Promise.all(
            addresses.map((address) =>
              ethers.getContractAt('LendingMarket', address),
            ),
          ),
        ),
      Promise.all(
        maturities.map((maturity) =>
          lendingMarketController
            .getFutureValueVault(hexETH, maturity)
            .then((address) =>
              ethers.getContractAt('FutureValueVault', address),
            ),
        ),
      ),
    ]);
  };

  before('Deploy Contracts', async () => {
    signers = new Signers(await ethers.getSigners());
    [owner] = await signers.get(1);

    ({
      genesisDate,
      addressResolver,
      genesisValueVault,
      reserveFund,
      tokenVault,
      lendingMarketController,
      wETHToken,
      eFILToken,
    } = await deployContracts());

    await tokenVault.registerCurrency(hexETH, wETHToken.address, false);
    await tokenVault.registerCurrency(hexEFIL, eFILToken.address, false);

    await tokenVault.setCollateralParameters(
      LIQUIDATION_THRESHOLD_RATE,
      LIQUIDATION_PROTOCOL_FEE_RATE,
      LIQUIDATOR_FEE_RATE,
    );

    await tokenVault.updateCurrency(hexETH, true);

    // Deploy active Lending Markets
    for (let i = 0; i < 8; i++) {
      await lendingMarketController.createLendingMarket(hexEFIL, genesisDate);
      await lendingMarketController.createLendingMarket(hexETH, genesisDate);
    }

    maturities = await lendingMarketController.getMaturities(hexETH);

    // Deploy inactive Lending Markets for Itayose
    await lendingMarketController.createLendingMarket(hexEFIL, maturities[0]);
    await lendingMarketController.createLendingMarket(hexETH, maturities[0]);
  });

  beforeEach('Reset contract instances', async () => {
    await resetContractInstances();
  });

  describe('Execute auto-roll with orders on the single market', async () => {
    const orderAmount = BigNumber.from('100000000000000000');

    before(async () => {
      [alice, bob, carol] = await getUsers(3);
    });

    it('Fill an order', async () => {
      await tokenVault.connect(bob).deposit(hexETH, orderAmount.mul(2), {
        value: orderAmount.mul(2),
      });

      await tokenVault.connect(carol).deposit(hexETH, orderAmount.mul(10), {
        value: orderAmount.mul(10),
      });

      await expect(
        lendingMarketController
          .connect(alice)
          .depositAndCreateOrder(
            hexETH,
            maturities[0],
            Side.LEND,
            orderAmount,
            8000,
            {
              value: orderAmount,
            },
          ),
      ).to.emit(lendingMarkets[0], 'OrderMade');

      await expect(
        lendingMarketController
          .connect(carol)
          .createOrder(
            hexETH,
            maturities[0],
            Side.LEND,
            orderAmount.mul(3),
            8000,
          ),
      ).to.emit(lendingMarkets[0], 'OrderMade');

      await expect(
        lendingMarketController
          .connect(carol)
          .createOrder(hexETH, maturities[0], Side.BORROW, orderAmount, 8010),
      ).to.emit(lendingMarkets[0], 'OrderMade');

      await expect(
        lendingMarketController
          .connect(bob)
          .createOrder(hexETH, maturities[0], Side.BORROW, orderAmount, 0),
      ).to.emit(lendingMarkets[0], 'OrdersTaken');

      // Check future value
      const { futureValue: aliceFVBefore } =
        await futureValueVaults[0].getFutureValue(alice.address);
      const { futureValue: bobFV } = await futureValueVaults[0].getFutureValue(
        bob.address,
      );
      const aliceActualFV = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[0],
        alice.address,
      );

      expect(aliceFVBefore).to.equal('0');
      expect(bobFV).not.to.equal('0');

      await lendingMarketController.cleanUpFunds(hexETH, alice.address);
      const { futureValue: aliceFVAfter } =
        await futureValueVaults[0].getFutureValue(alice.address);

      expect(aliceFVAfter).to.equal(aliceActualFV.abs());

      // Check present value
      const midUnitPrice = await lendingMarkets[0].getMidUnitPrice();
      const alicePV = await lendingMarketController.getTotalPresentValue(
        hexETH,
        alice.address,
      );

      expect(alicePV).to.equal(aliceActualFV.mul(midUnitPrice).div(BP));
    });

    it('Execute auto-roll (1st time)', async () => {
      await lendingMarketController
        .connect(carol)
        .depositAndCreateOrder(
          hexETH,
          maturities[1],
          Side.LEND,
          orderAmount.mul(2),
          8490,
          {
            value: orderAmount.mul(2),
          },
        );
      await lendingMarketController
        .connect(carol)
        .createOrder(
          hexETH,
          maturities[1],
          Side.BORROW,
          orderAmount.mul(2),
          8510,
        );

      const aliceFVBefore = await lendingMarketController.getFutureValue(
        hexETH,
        0,
        alice.address,
      );

      // Auto-roll
      await executeAutoRoll('8500');

      // Check if the orders in previous market is canceled
      const carolCoverageAfter = await tokenVault.getCoverage(carol.address);
      expect(carolCoverageAfter).to.equal('2000');

      // Check future value
      const aliceActualFV = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[0],
        alice.address,
      );
      expect(aliceActualFV).to.equal('0');

      // Check future value * genesis value
      const aliceFVAfter = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[1],
        alice.address,
      );

      const aliceGVAfter = await lendingMarketController.getGenesisValue(
        hexETH,
        alice.address,
      );

      const { lendingCompoundFactor: lendingCF0 } =
        await genesisValueVault.getAutoRollLog(hexETH, maturities[0]);
      const { lendingCompoundFactor: lendingCF1 } =
        await genesisValueVault.getAutoRollLog(hexETH, maturities[1]);
      const gvDecimals = await genesisValueVault.decimals(hexETH);

      expect(aliceFVAfter).to.equal(
        BigNumberJS(aliceFVBefore.toString())
          .times(lendingCF1.toString())
          .div(lendingCF0.toString())
          .dp(0)
          .toFixed(),
      );
      expect(aliceGVAfter).to.equal(
        BigNumberJS(aliceFVBefore.toString())
          .times(BigNumberJS(10).pow(gvDecimals.toString()))
          .div(lendingCF0.toString())
          .dp(0)
          .toFixed(),
      );

      // Check the saved unit price and compound factor per maturity
      const autoRollLog1 = await genesisValueVault.getAutoRollLog(
        hexETH,
        maturities[0],
      );
      const autoRollLog2 = await genesisValueVault.getAutoRollLog(
        hexETH,
        autoRollLog1.next.toString(),
      );

      expect(autoRollLog1.prev).to.equal('0');
      expect(autoRollLog2.prev).to.equal(maturities[0]);
      expect(autoRollLog2.next).to.equal('0');
      expect(autoRollLog2.unitPrice).to.equal('8500');
      expect(autoRollLog2.lendingCompoundFactor).to.equal(
        autoRollLog1.lendingCompoundFactor
          .mul(BP.pow(2).sub(autoRollLog2.unitPrice.mul(AUTO_ROLL_FEE_RATE)))
          .div(autoRollLog2.unitPrice.mul(BP)),
      );
    });

    it('Execute auto-roll (2nd time)', async () => {
      await lendingMarketController
        .connect(carol)
        .depositAndCreateOrder(
          hexETH,
          maturities[1],
          Side.LEND,
          orderAmount.mul(2),
          7900,
          {
            value: orderAmount.mul(2),
          },
        );
      await lendingMarketController
        .connect(carol)
        .createOrder(
          hexETH,
          maturities[1],
          Side.BORROW,
          orderAmount.mul(2),
          8100,
        );

      const aliceFVBefore = await lendingMarketController.getFutureValue(
        hexETH,
        0,
        alice.address,
      );

      // Auto-roll
      await executeAutoRoll('8000');

      // Check future value
      const aliceFVAfter = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[1],
        alice.address,
      );

      const { lendingCompoundFactor: lendingCF0 } =
        await genesisValueVault.getAutoRollLog(hexETH, maturities[0]);
      const { lendingCompoundFactor: lendingCF1 } =
        await genesisValueVault.getAutoRollLog(hexETH, maturities[1]);

      expect(aliceFVAfter).to.equal(
        BigNumberJS(aliceFVBefore.toString())
          .times(lendingCF1.toString())
          .div(lendingCF0.toString())
          .dp(0)
          .toFixed(),
      );

      // Check the saved unit price and compound factor per maturity
      const autoRollLog1 = await genesisValueVault.getAutoRollLog(
        hexETH,
        maturities[0],
      );
      const autoRollLog2 = await genesisValueVault.getAutoRollLog(
        hexETH,
        autoRollLog1.next.toString(),
      );

      expect(autoRollLog1.prev).not.to.equal('0');
      expect(autoRollLog2.prev).to.equal(maturities[0]);
      expect(autoRollLog2.next).to.equal('0');
      expect(autoRollLog2.unitPrice).to.equal('8000');
      expect(autoRollLog2.lendingCompoundFactor).to.equal(
        autoRollLog1.lendingCompoundFactor
          .mul(BP.pow(2).sub(autoRollLog2.unitPrice.mul(AUTO_ROLL_FEE_RATE)))
          .div(BP.mul(autoRollLog2.unitPrice)),
      );
    });
  });

  describe('Execute auto-roll with orders on the multiple markets', async () => {
    const orderAmount = BigNumber.from('100000000000000000');

    before(async () => {
      [alice, bob, carol] = await getUsers(3);
    });

    it('Fill an order on the closest maturity market', async () => {
      await tokenVault.connect(bob).deposit(hexETH, orderAmount.mul(2), {
        value: orderAmount.mul(2),
      });

      await expect(
        lendingMarketController
          .connect(alice)
          .depositAndCreateOrder(
            hexETH,
            maturities[0],
            Side.LEND,
            orderAmount,
            8000,
            {
              value: orderAmount,
            },
          ),
      ).to.emit(lendingMarkets[0], 'OrderMade');

      await expect(
        lendingMarketController
          .connect(bob)
          .createOrder(hexETH, maturities[0], Side.BORROW, orderAmount, 0),
      ).to.emit(lendingMarkets[0], 'OrdersTaken');

      await createSampleETHOrders(carol, maturities[0], '8000');

      // Check future value
      const aliceActualFV = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[0],
        alice.address,
      );

      expect(aliceActualFV).equal('125000000000000000');
    });

    it('Fill an order on the second closest maturity market', async () => {
      await tokenVault.connect(bob).deposit(hexETH, orderAmount.mul(2), {
        value: orderAmount.mul(2),
      });

      await expect(
        lendingMarketController
          .connect(alice)
          .depositAndCreateOrder(
            hexETH,
            maturities[1],
            Side.LEND,
            orderAmount,
            5000,
            {
              value: orderAmount,
            },
          ),
      ).to.emit(lendingMarkets[1], 'OrderMade');

      await expect(
        lendingMarketController
          .connect(bob)
          .createOrder(hexETH, maturities[1], Side.BORROW, orderAmount, 0),
      ).to.emit(lendingMarkets[1], 'OrdersTaken');

      await createSampleETHOrders(carol, maturities[1], '5000');

      // Check future value
      const aliceActualFV = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[1],
        alice.address,
      );
      const bobActualFV = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[1],
        bob.address,
      );

      expect(aliceActualFV).equal('200000000000000000');
      expect(
        BigNumberJS(aliceActualFV.toString())
          .times(10000)
          .div(bobActualFV.toString())
          .dp(0)
          .abs()
          .toFixed(),
      ).to.equal('9950');
    });

    it('Check total PVs', async () => {
      const alicePV = await lendingMarketController.getTotalPresentValue(
        hexETH,
        alice.address,
      );
      const bobPV = await lendingMarketController.getTotalPresentValue(
        hexETH,
        bob.address,
      );

      expect(alicePV).equal('200000000000000000');
      expect(alicePV.mul(10000).div(bobPV).abs().sub(9950)).to.gt(0);
    });

    it('Execute auto-roll', async () => {
      const [alicePVs, bobPVs] = await Promise.all(
        [alice, bob].map(async (user) =>
          Promise.all([
            lendingMarketController.getTotalPresentValue(hexETH, user.address),
            lendingMarketController.getPresentValue(
              hexETH,
              maturities[0],
              user.address,
            ),
            lendingMarketController.getPresentValue(
              hexETH,
              maturities[1],
              user.address,
            ),
          ]),
        ),
      );

      const [aliceTotalPVBefore, alicePV0Before, alicePV1Before] = alicePVs;
      const [bobTotalPVBefore, bobPV0Before, bobPV1Before] = bobPVs;

      const aliceFV0Before = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[0],
        alice.address,
      );
      const aliceFV1Before = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[1],
        alice.address,
      );

      expect(alicePV0Before).equal(orderAmount);
      expect(aliceTotalPVBefore).to.equal(alicePV0Before.add(alicePV1Before));
      expect(bobTotalPVBefore).to.equal(bobPV0Before.add(bobPV1Before));
      expect(
        aliceTotalPVBefore.mul(10000).div(bobTotalPVBefore).abs().sub(9950),
      ).to.gt(0);

      // Auto-roll
      await executeAutoRoll();

      // Check present value
      const aliceTotalPVAfter =
        await lendingMarketController.getTotalPresentValue(
          hexETH,
          alice.address,
        );
      const alicePV0After = await lendingMarketController.getPresentValue(
        hexETH,
        maturities[0],
        alice.address,
      );
      const alicePV1After = await lendingMarketController.getPresentValue(
        hexETH,
        maturities[1],
        alice.address,
      );

      expect(alicePV0After).to.equal('0');
      expect(alicePV1After).to.equal(aliceTotalPVAfter);

      // Check future value
      const { lendingCompoundFactor: lendingCF0 } =
        await genesisValueVault.getAutoRollLog(hexETH, maturities[0]);
      const { lendingCompoundFactor: lendingCF1 } =
        await genesisValueVault.getAutoRollLog(hexETH, maturities[1]);
      const aliceFV1After = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[1],
        alice.address,
      );

      expect(
        aliceFV1After
          .sub(
            BigNumberJS(aliceFV0Before.toString())
              .times(lendingCF1.toString())
              .div(lendingCF0.toString())
              .plus(aliceFV1Before.toString())
              .dp(0)
              .toFixed(),
          )
          .abs(),
      ).lte(1);
    });

    it('Clean orders', async () => {
      const alicePV0Before = await lendingMarketController.getPresentValue(
        hexETH,
        maturities[0],
        alice.address,
      );
      const alicePV1Before = await lendingMarketController.getPresentValue(
        hexETH,
        maturities[1],
        alice.address,
      );

      await lendingMarketController.cleanUpFunds(hexETH, alice.address);

      const alicePV0After = await lendingMarketController.getPresentValue(
        hexETH,
        maturities[0],
        alice.address,
      );
      const alicePV1After = await lendingMarketController.getPresentValue(
        hexETH,
        maturities[1],
        alice.address,
      );

      expect(alicePV0Before).to.equal(alicePV0After);
      expect(alicePV1Before).to.equal(alicePV1After);
      expect(alicePV1After).to.equal('0');
    });
  });

  describe('Execute auto-rolls more times than the number of markets using the past auto-roll price', async () => {
    const orderAmount = BigNumber.from('1000000000000000000000');

    before(async () => {
      [alice, bob, carol] = await getUsers(3);
      await resetContractInstances();
      await executeAutoRoll('8333');
    });

    it('Fill an order', async () => {
      await tokenVault.connect(bob).deposit(hexETH, orderAmount.mul(2), {
        value: orderAmount.mul(2),
      });

      await expect(
        lendingMarketController
          .connect(alice)
          .depositAndCreateOrder(
            hexETH,
            maturities[0],
            Side.LEND,
            orderAmount,
            '8333',
            {
              value: orderAmount,
            },
          ),
      ).to.emit(lendingMarkets[0], 'OrderMade');

      await expect(
        lendingMarketController
          .connect(bob)
          .createOrder(hexETH, maturities[0], Side.BORROW, orderAmount, 0),
      ).to.emit(lendingMarkets[0], 'OrdersTaken');

      await createSampleETHOrders(owner, maturities[1], '8333');

      // Check future value
      const aliceActualFV = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[0],
        alice.address,
      );

      expect(aliceActualFV).to.equal('1200048001920076803072');
    });

    for (let i = 0; i <= 9; i++) {
      it(`Execute auto-roll (${formatOrdinals(i + 1)} time)`, async () => {
        const aliceFV0Before = await lendingMarketController.getFutureValue(
          hexETH,
          maturities[0],
          alice.address,
        );
        const aliceFV1Before = await lendingMarketController.getFutureValue(
          hexETH,
          maturities[1],
          alice.address,
        );

        // Auto-roll
        await executeAutoRoll();

        // Check present value
        const aliceTotalPVAfter =
          await lendingMarketController.getTotalPresentValue(
            hexETH,
            alice.address,
          );
        const alicePV0After = await lendingMarketController.getPresentValue(
          hexETH,
          maturities[0],
          alice.address,
        );
        const alicePV1After = await lendingMarketController.getPresentValue(
          hexETH,
          maturities[1],
          alice.address,
        );

        expect(alicePV0After).to.equal('0');
        expect(alicePV1After).to.equal(aliceTotalPVAfter);

        // Check future value
        const { lendingCompoundFactor: lendingCF0 } =
          await genesisValueVault.getAutoRollLog(hexETH, maturities[0]);
        const { lendingCompoundFactor: lendingCF1 } =
          await genesisValueVault.getAutoRollLog(hexETH, maturities[1]);
        const aliceFV1After = await lendingMarketController.getFutureValue(
          hexETH,
          maturities[1],
          alice.address,
        );

        expect(
          aliceFV1After
            .sub(
              BigNumberJS(aliceFV0Before.toString())
                .times(lendingCF1.toString())
                .div(lendingCF0.toString())
                .plus(aliceFV1Before.toString())
                .dp(0)
                .toFixed(),
            )
            .abs(),
        ).lte(1);
      });
    }
  });

  describe('Execute auto-roll with many orders, Check the FV and GV', async () => {
    const orderAmount = BigNumber.from('100000000000000000');

    before(async () => {
      [alice, bob, carol, dave] = await getUsers(4);
      await resetContractInstances();
      await executeAutoRoll('8000');
      await resetContractInstances();
      await executeAutoRoll();
      await resetContractInstances();
    });

    it('Fill an order', async () => {
      await tokenVault.connect(dave).deposit(hexETH, orderAmount.mul(10), {
        value: orderAmount.mul(10),
      });

      for (const [i, user] of [alice, bob, carol].entries()) {
        await expect(
          lendingMarketController
            .connect(user)
            .depositAndCreateOrder(
              hexETH,
              maturities[0],
              Side.LEND,
              orderAmount,
              8000 - i,
              {
                value: orderAmount,
              },
            ),
        ).to.emit(lendingMarkets[0], 'OrderMade');
      }

      await expect(
        lendingMarketController
          .connect(dave)
          .createOrder(
            hexETH,
            maturities[0],
            Side.BORROW,
            orderAmount.mul(3),
            0,
          ),
      ).to.emit(lendingMarkets[0], 'OrdersTaken');

      // Check present value
      const daveActualFV = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[0],
        dave.address,
      );

      const midUnitPrice = await lendingMarkets[0].getMidUnitPrice();
      const davePV = await lendingMarketController.getTotalPresentValue(
        hexETH,
        dave.address,
      );

      expect(davePV.sub(daveActualFV.mul(midUnitPrice).div(BP)).abs()).lte(1);
    });

    it('Check future values', async () => {
      const checkFutureValue = async () => {
        for (const { address } of [owner, alice, bob, carol]) {
          await lendingMarketController.cleanUpFunds(hexETH, address);
        }

        const gvAmounts = await Promise.all(
          [owner, alice, bob, carol, dave, reserveFund].map(({ address }) =>
            futureValueVaults[0].getFutureValue(address),
          ),
        ).then((results) => results.map(({ futureValue }) => futureValue));

        expect(
          gvAmounts.reduce(
            (total, current) => total.add(current),
            BigNumber.from(0),
          ),
        ).to.equal('0');
      };

      await checkFutureValue();
    });

    it('Execute auto-roll, Check genesis values', async () => {
      const users = [alice, bob, carol, dave, reserveFund];

      const reserveFundGVAmountBefore = await genesisValueVault.getGenesisValue(
        hexETH,
        reserveFund.address,
      );

      // Auto-roll
      await time.increaseTo(maturities[0].toString());
      await lendingMarketController.connect(owner).rotateLendingMarkets(hexETH);

      await lendingMarketController.executeItayoseCalls(
        [hexETH],
        maturities[maturities.length - 1],
      );

      for (const { address } of users) {
        await lendingMarketController.cleanUpFunds(hexETH, address);
      }

      const [
        aliceGVAmount,
        bobGVAmount,
        carolGVAmount,
        daveGVAmount,
        reserveFundGVAmount,
      ] = await Promise.all(
        users.map(({ address }) =>
          lendingMarketController.getGenesisValue(hexETH, address),
        ),
      );

      expect(
        aliceGVAmount
          .add(bobGVAmount)
          .add(carolGVAmount)
          .add(reserveFundGVAmount.sub(reserveFundGVAmountBefore))
          .add(daveGVAmount),
      ).to.equal('0');
    });
  });

  describe('Execute auto-roll well past maturity', async () => {
    const orderAmount = BigNumber.from('100000000000000000');

    before(async () => {
      [alice, bob, carol] = await getUsers(3);
      await resetContractInstances();
      await executeAutoRoll('8000');
    });

    it('Fill an order', async () => {
      await tokenVault.connect(bob).deposit(hexETH, orderAmount.mul(2), {
        value: orderAmount.mul(2),
      });

      await expect(
        lendingMarketController
          .connect(alice)
          .depositAndCreateOrder(
            hexETH,
            maturities[0],
            Side.LEND,
            orderAmount,
            '8000',
            {
              value: orderAmount,
            },
          ),
      ).to.emit(lendingMarkets[0], 'OrderMade');

      await expect(
        lendingMarketController
          .connect(bob)
          .createOrder(hexETH, maturities[0], Side.BORROW, orderAmount, 0),
      ).to.emit(lendingMarkets[0], 'OrdersTaken');

      // Check future value
      const aliceActualFV = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[0],
        alice.address,
      );

      expect(aliceActualFV).to.equal('125000000000000000');
    });

    it('Advance time', async () => {
      const alicePV0Before = await lendingMarketController.getPresentValue(
        hexETH,
        maturities[0],
        alice.address,
      );
      const alicePV1Before = await lendingMarketController.getPresentValue(
        hexETH,
        maturities[1],
        alice.address,
      );

      await time.increaseTo(maturities[0].toString());
      const alicePV0After = await lendingMarketController.getPresentValue(
        hexETH,
        maturities[0],
        alice.address,
      );
      const alicePV1After = await lendingMarketController.getPresentValue(
        hexETH,
        maturities[1],
        alice.address,
      );

      expect(alicePV0Before).to.equal(alicePV0After);
      expect(alicePV1Before).to.equal(alicePV1After);
    });

    it('Fail to create an order due to market closure', async () => {
      await expect(
        lendingMarketController
          .connect(alice)
          .depositAndCreateOrder(
            hexETH,
            maturities[0],
            Side.LEND,
            orderAmount,
            8000,
            {
              value: orderAmount,
            },
          ),
      ).to.be.revertedWith('Market is not opened');
    });

    it(`Execute auto-roll`, async () => {
      const aliceFV0Before = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[0],
        alice.address,
      );
      const aliceFV1Before = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[1],
        alice.address,
      );

      // Auto-roll
      await createSampleETHOrders(carol, maturities[1], '8000');
      await time.increaseTo(maturities[1].toString());
      await lendingMarketController.connect(owner).rotateLendingMarkets(hexETH);

      await lendingMarketController.executeItayoseCalls(
        [hexETH],
        maturities[maturities.length - 1],
      );

      // Check present value
      const aliceTotalPVAfter =
        await lendingMarketController.getTotalPresentValue(
          hexETH,
          alice.address,
        );
      const alicePV0After = await lendingMarketController.getPresentValue(
        hexETH,
        maturities[0],
        alice.address,
      );
      const alicePV1After = await lendingMarketController.getPresentValue(
        hexETH,
        maturities[1],
        alice.address,
      );

      expect(alicePV0After).to.equal('0');
      expect(alicePV1After).to.equal(aliceTotalPVAfter);

      // Check future value
      const { lendingCompoundFactor: lendingCF0 } =
        await genesisValueVault.getAutoRollLog(hexETH, maturities[0]);
      const { lendingCompoundFactor: lendingCF1 } =
        await genesisValueVault.getAutoRollLog(hexETH, maturities[1]);
      const aliceFV1After = await lendingMarketController.getFutureValue(
        hexETH,
        maturities[1],
        alice.address,
      );

      expect(
        aliceFV1After
          .sub(
            BigNumberJS(aliceFV0Before.toString())
              .times(lendingCF1.toString())
              .div(lendingCF0.toString())
              .plus(aliceFV1Before.toString())
              .dp(0)
              .toFixed(),
          )
          .abs(),
      ).lte(1);
    });
  });
});
