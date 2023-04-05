import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber, Contract } from 'ethers';
import { ethers } from 'hardhat';

import { Side } from '../../utils/constants';
import { hexEFIL, hexWETH } from '../../utils/strings';
import {
  eFilToETHRate,
  LIQUIDATION_PROTOCOL_FEE_RATE,
  LIQUIDATION_THRESHOLD_RATE,
  LIQUIDATOR_FEE_RATE,
} from '../common/constants';
import { deployContracts } from '../common/deployment';
import { calculateOrderFee } from '../common/orders';
import { Signers } from '../common/signers';

describe('Integration Test: Order Book', async () => {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let dave: SignerWithAddress;

  let addressResolver: Contract;
  let currencyController: Contract;
  let tokenVault: Contract;
  let lendingMarketController: Contract;
  let wETHToken: Contract;
  let eFILToken: Contract;
  let mockUniswapRouter: Contract;
  let mockUniswapQuoter: Contract;

  let fundManagementLogic: Contract;

  let genesisDate: number;
  let filLendingMarkets: Contract[] = [];
  let filMaturities: BigNumber[];
  let ethMaturities: BigNumber[];

  let signers: Signers;

  const initialETHBalance = BigNumber.from('1000000000000000000');
  const initialFILBalance = BigNumber.from('100000000000000000000');

  const getUsers = async (count: number) =>
    signers.get(count, async (signer) => {
      await eFILToken
        .connect(owner)
        .transfer(signer.address, initialFILBalance);
    });

  const createSampleETHOrders = async (user: SignerWithAddress) => {
    await tokenVault.connect(user).deposit(hexWETH, initialETHBalance.div(3), {
      value: initialETHBalance.div(3),
    });

    await lendingMarketController
      .connect(user)
      .createOrder(hexWETH, ethMaturities[0], Side.BORROW, '1000', '8200');

    await lendingMarketController
      .connect(user)
      .createOrder(hexWETH, ethMaturities[0], Side.LEND, '1000', '7800');
  };

  const createSampleFILOrders = async (user: SignerWithAddress) => {
    await eFILToken
      .connect(user)
      .approve(tokenVault.address, initialFILBalance);
    await tokenVault.connect(user).deposit(hexEFIL, initialFILBalance);
    await tokenVault.connect(user).deposit(hexWETH, initialETHBalance.div(3), {
      value: initialETHBalance.div(3),
    });

    await lendingMarketController
      .connect(user)
      .createOrder(hexEFIL, filMaturities[0], Side.BORROW, '1000', '8200');

    await lendingMarketController
      .connect(user)
      .createOrder(hexEFIL, filMaturities[0], Side.LEND, '1000', '7800');
  };

  before('Deploy Contracts', async () => {
    signers = new Signers(await ethers.getSigners());
    [owner] = await signers.get(1);

    ({
      genesisDate,
      fundManagementLogic,
      addressResolver,
      currencyController,
      tokenVault,
      lendingMarketController,
      wETHToken,
      eFILToken,
    } = await deployContracts());

    await tokenVault.registerCurrency(hexWETH, wETHToken.address, false);
    await tokenVault.registerCurrency(hexEFIL, eFILToken.address, false);

    mockUniswapRouter = await ethers
      .getContractFactory('MockUniswapRouter')
      .then((factory) =>
        factory.deploy(addressResolver.address, wETHToken.address),
      );
    mockUniswapQuoter = await ethers
      .getContractFactory('MockUniswapQuoter')
      .then((factory) =>
        factory.deploy(addressResolver.address, wETHToken.address),
      );

    await mockUniswapRouter.setToken(hexWETH, wETHToken.address);
    await mockUniswapRouter.setToken(hexEFIL, eFILToken.address);
    await mockUniswapQuoter.setToken(hexWETH, wETHToken.address);
    await mockUniswapQuoter.setToken(hexEFIL, eFILToken.address);

    await tokenVault.setCollateralParameters(
      LIQUIDATION_THRESHOLD_RATE,
      LIQUIDATION_PROTOCOL_FEE_RATE,
      LIQUIDATOR_FEE_RATE,
      mockUniswapRouter.address,
      mockUniswapQuoter.address,
    );

    await tokenVault.updateCurrency(hexWETH, true);

    // Deploy Lending Markets for FIL market
    for (let i = 0; i < 8; i++) {
      await lendingMarketController.createLendingMarket(hexEFIL, genesisDate);
      await lendingMarketController.createLendingMarket(hexWETH, genesisDate);
    }

    filLendingMarkets = await lendingMarketController
      .getLendingMarkets(hexEFIL)
      .then((addresses) =>
        Promise.all(
          addresses.map((address) =>
            ethers.getContractAt('LendingMarket', address),
          ),
        ),
      );
  });

  describe('Market orders', async () => {
    describe('Add orders using the same currency as the collateral, Fill the order, Unwind the ETH order', async () => {
      const orderAmount = initialETHBalance.div(5);
      const depositAmount = orderAmount.mul(3).div(2);

      before(async () => {
        [alice, bob, carol] = await getUsers(3);
        ethMaturities = await lendingMarketController.getMaturities(hexWETH);
        await createSampleETHOrders(carol);
      });

      it('Deposit ETH', async () => {
        await tokenVault.connect(alice).deposit(hexWETH, depositAmount, {
          value: depositAmount,
        });

        const aliceDepositAmount = await tokenVault.getDepositAmount(
          alice.address,
          hexWETH,
        );

        expect(aliceDepositAmount).to.equal(depositAmount);
      });

      it('Fill an order on the ETH market', async () => {
        await lendingMarketController
          .connect(bob)
          .depositAndCreateOrder(
            hexWETH,
            ethMaturities[0],
            Side.LEND,
            orderAmount,
            '8000',
            { value: orderAmount },
          );

        const { blockHash } = await lendingMarketController
          .connect(alice)
          .createOrder(
            hexWETH,
            ethMaturities[0],
            Side.BORROW,
            orderAmount,
            '8000',
          );

        const { timestamp } = await ethers.provider.getBlock(blockHash);
        const fee = calculateOrderFee(
          orderAmount,
          '8000',
          ethMaturities[0].sub(timestamp),
        );

        const [aliceFV, bobFV] = await Promise.all(
          [alice, bob].map(({ address }) =>
            lendingMarketController.getFutureValue(
              hexWETH,
              ethMaturities[0],
              address,
            ),
          ),
        );

        expect(bobFV.sub(orderAmount.mul(10).div(8))).lte(1);
        expect(bobFV.add(aliceFV).add(fee)).to.lte(1);
      });

      it('Check collateral', async () => {
        const coverage = await tokenVault.getCoverage(alice.address);
        const aliceDepositAmount = await tokenVault.getDepositAmount(
          alice.address,
          hexWETH,
        );
        const bobDepositAmount = await tokenVault.getDepositAmount(
          bob.address,
          hexWETH,
        );

        expect(aliceDepositAmount).to.equal(depositAmount.add(orderAmount));
        expect(bobDepositAmount).to.equal('0');
      });

      it('Unwind all orders', async () => {
        await lendingMarketController
          .connect(carol)
          .depositAndCreateOrder(
            hexWETH,
            ethMaturities[0],
            Side.BORROW,
            orderAmount.mul(2),
            '8000',
            { value: orderAmount.mul(2) },
          );

        await expect(
          lendingMarketController
            .connect(alice)
            .unwindOrder(hexWETH, ethMaturities[0]),
        ).to.emit(
          fundManagementLogic.attach(lendingMarketController.address),
          'OrderFilled',
        );

        const aliceFV = await lendingMarketController.getFutureValue(
          hexWETH,
          ethMaturities[0],
          alice.address,
        );

        expect(aliceFV).to.equal(0);

        await lendingMarketController
          .connect(carol)
          .cancelOrder(hexWETH, ethMaturities[0], '5');
      });
    });

    describe('Add orders using the different currency as the collateral, Fill the order, Unwind the non-ETH order', async () => {
      const depositAmount = initialETHBalance.div(5);
      const orderAmount = depositAmount
        .mul(4)
        .div(5)
        .mul(BigNumber.from(10).pow(18))
        .div(eFilToETHRate);

      before(async () => {
        [alice, bob, carol, dave] = await getUsers(4);
        filMaturities = await lendingMarketController.getMaturities(hexEFIL);
        await createSampleFILOrders(carol);
      });

      it('Deposit ETH ', async () => {
        await tokenVault.connect(alice).deposit(hexWETH, depositAmount, {
          value: depositAmount,
        });

        const aliceDepositAmount = await tokenVault.getDepositAmount(
          alice.address,
          hexWETH,
        );

        expect(aliceDepositAmount).to.equal(depositAmount);
      });

      it('Fill an order on the FIL market', async () => {
        await eFILToken
          .connect(bob)
          .approve(tokenVault.address, initialFILBalance);

        await lendingMarketController
          .connect(bob)
          .depositAndCreateOrder(
            hexEFIL,
            filMaturities[0],
            Side.LEND,
            orderAmount,
            '8000',
          );

        const { blockHash } = await lendingMarketController
          .connect(alice)
          .createOrder(
            hexEFIL,
            filMaturities[0],
            Side.BORROW,
            orderAmount,
            '0',
          );

        const { timestamp } = await ethers.provider.getBlock(blockHash);
        const fee = calculateOrderFee(
          orderAmount,
          '8000',
          ethMaturities[0].sub(timestamp),
        );

        const [aliceFV, bobFV] = await Promise.all(
          [alice, bob].map(({ address }) =>
            lendingMarketController.getFutureValue(
              hexEFIL,
              filMaturities[0],
              address,
            ),
          ),
        );

        expect(bobFV.sub(orderAmount.mul(10).div(8))).lte(1);
        expect(bobFV.add(aliceFV).add(fee)).to.lte(1);
      });

      it('Check collateral', async () => {
        const coverage = await tokenVault.getCoverage(alice.address);
        const aliceFILDepositAmount = await tokenVault.getDepositAmount(
          alice.address,
          hexEFIL,
        );
        const bobFILDepositAmount = await tokenVault.getDepositAmount(
          bob.address,
          hexEFIL,
        );

        expect(aliceFILDepositAmount).to.equal(orderAmount);
        expect(bobFILDepositAmount).to.equal('0');
      });

      it('Unwind all orders', async () => {
        await tokenVault.connect(dave).deposit(hexWETH, depositAmount.mul(2), {
          value: depositAmount.mul(2),
        });

        await lendingMarketController
          .connect(dave)
          .createOrder(
            hexEFIL,
            filMaturities[0],
            Side.BORROW,
            orderAmount.mul(2),
            '8000',
          );

        await expect(
          lendingMarketController
            .connect(alice)
            .unwindOrder(hexEFIL, filMaturities[0]),
        ).to.be.revertedWith('Not enough collateral in the selected currency');

        // Deposit the amount that is not enough due to fees being deducted.
        await eFILToken
          .connect(alice)
          .approve(tokenVault.address, orderAmount.div(30));
        await tokenVault.connect(alice).deposit(hexEFIL, orderAmount.div(30));

        await expect(
          lendingMarketController
            .connect(alice)
            .unwindOrder(hexEFIL, filMaturities[0]),
        ).to.emit(
          fundManagementLogic.attach(lendingMarketController.address),
          'OrderFilled',
        );

        const aliceFV = await lendingMarketController.getFutureValue(
          hexEFIL,
          filMaturities[0],
          alice.address,
        );

        expect(aliceFV).to.equal(0);

        await lendingMarketController
          .connect(dave)
          .cancelOrder(hexEFIL, filMaturities[0], '5');
      });
    });

    describe('Fill orders on multiple markets, Unwind partially', async () => {
      const depositAmount = initialETHBalance.div(5);
      const orderAmountInETH = depositAmount.mul(2).div(5);
      const orderAmountInFIL = orderAmountInETH
        .mul(BigNumber.from(10).pow(18))
        .div(eFilToETHRate);

      before(async () => {
        [alice, bob, carol, dave] = await getUsers(4);
        filMaturities = await lendingMarketController.getMaturities(hexEFIL);
        ethMaturities = await lendingMarketController.getMaturities(hexWETH);
        await createSampleFILOrders(carol);
        await createSampleETHOrders(carol);
      });

      it('Deposit ETH ', async () => {
        await tokenVault.connect(alice).deposit(hexWETH, depositAmount, {
          value: depositAmount,
        });

        const aliceDepositAmount = await tokenVault.getDepositAmount(
          alice.address,
          hexWETH,
        );

        expect(aliceDepositAmount).to.equal(depositAmount);
      });

      it('Fill an order on the FIL market', async () => {
        await eFILToken
          .connect(bob)
          .approve(tokenVault.address, initialFILBalance);

        await lendingMarketController
          .connect(bob)
          .depositAndCreateOrder(
            hexEFIL,
            filMaturities[0],
            Side.LEND,
            orderAmountInFIL,
            '8000',
          );

        const { blockHash } = await lendingMarketController
          .connect(alice)
          .createOrder(
            hexEFIL,
            filMaturities[0],
            Side.BORROW,
            orderAmountInFIL,
            '0',
          );

        const { timestamp } = await ethers.provider.getBlock(blockHash);
        const fee = calculateOrderFee(
          orderAmountInFIL,
          '8000',
          filMaturities[0].sub(timestamp),
        );

        const [aliceFV, bobFV] = await Promise.all(
          [alice, bob].map(({ address }) =>
            lendingMarketController.getFutureValue(
              hexEFIL,
              filMaturities[0],
              address,
            ),
          ),
        );

        const bobTotalCollateralAmountAfter =
          await tokenVault.getTotalCollateralAmount(bob.address);

        expect(bobFV.add(aliceFV).add(fee)).to.lte(1);
        expect(bobFV.sub(orderAmountInFIL.mul(5).div(2))).lte(1);
        expect(bobTotalCollateralAmountAfter.sub(orderAmountInETH.div(2))).lte(
          1,
        );
      });

      it('Fill an order on the ETH market', async () => {
        const orderAmount = orderAmountInETH.div(2);

        await lendingMarketController
          .connect(bob)
          .depositAndCreateOrder(
            hexWETH,
            ethMaturities[0],
            Side.LEND,
            orderAmount,
            '8000',
            { value: orderAmount },
          );

        const { blockHash } = await lendingMarketController
          .connect(alice)
          .createOrder(
            hexWETH,
            ethMaturities[0],
            Side.BORROW,
            orderAmount,
            '0',
          );

        const { timestamp } = await ethers.provider.getBlock(blockHash);
        const fee = calculateOrderFee(
          orderAmount,
          '8000',
          ethMaturities[0].sub(timestamp),
        );

        const [aliceFV, bobFV] = await Promise.all(
          [alice, bob].map(({ address }) =>
            lendingMarketController.getFutureValue(
              hexWETH,
              ethMaturities[0],
              address,
            ),
          ),
        );

        expect(bobFV.sub(orderAmount.mul(5).div(2))).lte(1);
        expect(bobFV.add(aliceFV).add(fee)).to.lte(1);
      });

      it('Check collateral', async () => {
        const coverage = await tokenVault.getCoverage(alice.address);
        const aliceFILDepositAmount = await tokenVault.getDepositAmount(
          alice.address,
          hexEFIL,
        );
        const bobFILDepositAmount = await tokenVault.getDepositAmount(
          bob.address,
          hexEFIL,
        );
        const aliceETHDepositAmount = await tokenVault.getDepositAmount(
          alice.address,
          hexWETH,
        );
        const bobETHDepositAmount = await tokenVault.getDepositAmount(
          bob.address,
          hexWETH,
        );
        const aliceTotalCollateralAmount =
          await tokenVault.getTotalCollateralAmount(alice.address);
        const bobTotalCollateralAmount =
          await tokenVault.getTotalCollateralAmount(bob.address);

        const filHaircut = await currencyController.getHaircut(hexEFIL);
        const ethHaircut = await currencyController.getHaircut(hexWETH);

        expect(aliceFILDepositAmount).to.equal(orderAmountInFIL);
        expect(aliceETHDepositAmount).to.equal(
          depositAmount.add(orderAmountInETH.div(2)),
        );
        expect(aliceTotalCollateralAmount).to.equal(aliceETHDepositAmount);
        expect(bobFILDepositAmount).to.equal('0');
        expect(bobETHDepositAmount).to.equal('0');
        expect(
          bobTotalCollateralAmount.sub(
            orderAmountInETH
              .mul(filHaircut)
              .add(orderAmountInETH.div(2).mul(ethHaircut))
              .div('10000'),
          ),
        );
      });

      it('Unwind orders partially', async () => {
        const aliceFVBefore = await lendingMarketController.getFutureValue(
          hexEFIL,
          filMaturities[0],
          alice.address,
        );

        await tokenVault.connect(dave).deposit(hexWETH, depositAmount.mul(2), {
          value: depositAmount.mul(2),
        });

        await lendingMarketController
          .connect(dave)
          .createOrder(
            hexEFIL,
            filMaturities[0],
            Side.BORROW,
            orderAmountInFIL.div(2),
            '8000',
          );

        await expect(
          lendingMarketController
            .connect(alice)
            .unwindOrder(hexEFIL, filMaturities[0]),
        ).to.emit(
          fundManagementLogic.attach(lendingMarketController.address),
          'OrderFilled',
        );

        const aliceFVAfter = await lendingMarketController.getFutureValue(
          hexEFIL,
          filMaturities[0],
          alice.address,
        );

        expect(aliceFVAfter.abs()).to.lte(aliceFVBefore.abs());
      });
    });
  });

  describe('Limit orders', async () => {
    const collateralAmount = initialETHBalance.div(5);
    let signer1: SignerWithAddress;
    let signer2: SignerWithAddress;
    let orderIds: number[];
    let orderMaker: SignerWithAddress;

    const inputs = [
      {
        label: 'borrowing',
        side1: Side.BORROW,
        side2: Side.LEND,
        signer1: 'bob',
        signer2: 'alice',
      },
      {
        label: 'lending',
        side1: Side.LEND,
        side2: Side.BORROW,
        signer1: 'alice',
        signer2: 'bob',
      },
    ];

    before(async () => {
      filMaturities = await lendingMarketController.getMaturities(hexEFIL);
    });

    afterEach(async () => {
      for (const orderId of orderIds || []) {
        await lendingMarketController
          .connect(orderMaker)
          .cancelOrder(hexEFIL, filMaturities[1], orderId);
      }

      orderIds = [];
    });

    for (const input of inputs) {
      describe(`Fill a ${input.label} order with the same amount`, async () => {
        let fee: BigNumber;

        it(`Create users`, async () => {
          [alice, bob] = await getUsers(2);

          await tokenVault.connect(bob).deposit(hexWETH, collateralAmount, {
            value: collateralAmount,
          });
        });

        it(`Fill an order`, async () => {
          signer1 = input.signer1 === 'bob' ? bob : alice;
          signer2 = input.signer2 === 'bob' ? bob : alice;

          await eFILToken
            .connect(alice)
            .approve(tokenVault.address, collateralAmount);
          await tokenVault.connect(alice).deposit(hexEFIL, collateralAmount, {
            value: collateralAmount,
          });

          await expect(
            lendingMarketController
              .connect(signer1)
              .createOrder(
                hexEFIL,
                filMaturities[1],
                input.side1,
                collateralAmount,
                '9001',
              ),
          ).to.emit(filLendingMarkets[1], 'OrderMade');

          const tx = await lendingMarketController
            .connect(signer2)
            .createOrder(
              hexEFIL,
              filMaturities[1],
              input.side2,
              collateralAmount,
              '9001',
            );

          await expect(tx).to.emit(filLendingMarkets[1], 'OrdersTaken');

          const { timestamp } = await ethers.provider.getBlock(tx.blockHash);
          fee = calculateOrderFee(
            collateralAmount,
            '9001',
            filMaturities[1].sub(timestamp),
          );
        });

        it(`Check orders`, async () => {
          const [aliceFV, bobFV] = await Promise.all(
            [alice, bob].map(({ address }) =>
              lendingMarketController.getFutureValue(
                hexEFIL,
                filMaturities[1],
                address,
              ),
            ),
          );
          const { activeOrderIds: borrowOrderIds } =
            await filLendingMarkets[1].getBorrowOrderIds(bob.address);
          const { activeOrderIds: lendOrderIds } =
            await filLendingMarkets[1].getLendOrderIds(alice.address);

          expect(bobFV.add(aliceFV).add(fee)).to.lte(1);
          expect(borrowOrderIds.length).to.equal(0);
          expect(lendOrderIds.length).to.equal(0);
        });
      });

      describe(`Fill a ${input.label} order with less amount`, async () => {
        let fee: BigNumber;

        it(`Create users`, async () => {
          [alice, bob] = await getUsers(2);

          await tokenVault.connect(bob).deposit(hexWETH, collateralAmount, {
            value: collateralAmount,
          });
        });

        it(`Fill an order`, async () => {
          signer1 = input.signer1 === 'bob' ? bob : alice;
          signer2 = input.signer2 === 'bob' ? bob : alice;

          await eFILToken
            .connect(alice)
            .approve(tokenVault.address, collateralAmount);
          await tokenVault.connect(alice).deposit(hexEFIL, collateralAmount, {
            value: collateralAmount,
          });

          await expect(
            lendingMarketController
              .connect(signer1)
              .createOrder(
                hexEFIL,
                filMaturities[1],
                input.side1,
                collateralAmount,
                '9002',
              ),
          ).to.emit(filLendingMarkets[1], 'OrderMade');

          const tx = lendingMarketController
            .connect(signer2)
            .createOrder(
              hexEFIL,
              filMaturities[1],
              input.side2,
              collateralAmount.div(2),
              '9002',
            );

          await expect(tx).to.emit(filLendingMarkets[1], 'OrdersTaken');

          const { timestamp } = await ethers.provider.getBlock(tx.blockHash);
          fee = calculateOrderFee(
            collateralAmount.div(2),
            '9002',
            filMaturities[1].sub(timestamp),
          );
        });

        it(`Check orders`, async () => {
          const [aliceFV, bobFV] = await Promise.all(
            [alice, bob].map(({ address }) =>
              lendingMarketController.getFutureValue(
                hexEFIL,
                filMaturities[1],
                address,
              ),
            ),
          );

          if (input.label === 'lending') {
            ({ activeOrderIds: orderIds } =
              await filLendingMarkets[1].getLendOrderIds(alice.address));
            orderMaker = alice;
          } else {
            ({ activeOrderIds: orderIds } =
              await filLendingMarkets[1].getBorrowOrderIds(bob.address));
            orderMaker = bob;
          }

          expect(bobFV.add(aliceFV).add(fee)).to.lte(1);
          expect(orderIds.length).to.equal(1);
        });
      });

      describe(`Fill a ${input.label} order with greater amount`, async () => {
        let fee: BigNumber;

        it(`Create users`, async () => {
          [alice, bob] = await getUsers(2);

          await tokenVault.connect(bob).deposit(hexWETH, collateralAmount, {
            value: collateralAmount,
          });
        });

        it(`Fill an order`, async () => {
          signer1 = input.signer1 === 'bob' ? bob : alice;
          signer2 = input.signer2 === 'bob' ? bob : alice;

          await eFILToken
            .connect(alice)
            .approve(tokenVault.address, collateralAmount.mul(3));
          await tokenVault
            .connect(alice)
            .deposit(hexEFIL, collateralAmount.mul(3), {
              value: collateralAmount.mul(3),
            });

          await expect(
            lendingMarketController
              .connect(signer1)
              .createOrder(
                hexEFIL,
                filMaturities[1],
                input.side1,
                collateralAmount.div(2),
                '9003',
              ),
          ).to.emit(filLendingMarkets[1], 'OrderMade');
          await expect(
            lendingMarketController
              .connect(signer1)
              .createOrder(
                hexEFIL,
                filMaturities[1],
                input.side1,
                collateralAmount.div(2),
                '9003',
              ),
          ).to.emit(filLendingMarkets[1], 'OrderMade');

          const tx = await lendingMarketController
            .connect(signer2)
            .createOrder(
              hexEFIL,
              filMaturities[1],
              input.side2,
              collateralAmount.mul(2),
              '9003',
            );

          await expect(tx).to.emit(filLendingMarkets[1], 'OrdersTaken');

          const { timestamp } = await ethers.provider.getBlock(tx.blockHash);
          fee = calculateOrderFee(
            collateralAmount,
            '9003',
            filMaturities[1].sub(timestamp),
          );
        });

        it(`Check orders`, async () => {
          const [aliceFV, bobFV] = await Promise.all(
            [alice, bob].map(({ address }) =>
              lendingMarketController.getFutureValue(
                hexEFIL,
                filMaturities[1],
                address,
              ),
            ),
          );

          if (input.label === 'borrowing') {
            ({ activeOrderIds: orderIds } =
              await filLendingMarkets[1].getLendOrderIds(alice.address));
            orderMaker = alice;
          } else {
            ({ activeOrderIds: orderIds } =
              await filLendingMarkets[1].getBorrowOrderIds(bob.address));
            orderMaker = bob;
          }

          expect(bobFV.add(aliceFV).add(fee)).to.lte(1);
          expect(orderIds.length).to.equal(1);
        });
      });
    }
  });

  describe('Order Cancellation', async () => {
    describe('Place a borrowing order, Cancel orders', async () => {
      const depositAmountInETH = initialETHBalance.div(5);
      const orderAmountInETH = depositAmountInETH.mul(4).div(5);
      const orderAmountInFIL = orderAmountInETH
        .mul(BigNumber.from(10).pow(18))
        .div(eFilToETHRate);

      before(async () => {
        [alice, bob, carol] = await getUsers(3);
        filMaturities = await lendingMarketController.getMaturities(hexEFIL);
        await createSampleFILOrders(carol);
      });

      it('Deposit ETH', async () => {
        await tokenVault.connect(alice).deposit(hexWETH, depositAmountInETH, {
          value: depositAmountInETH,
        });

        const aliceDepositAmount = await tokenVault.getDepositAmount(
          alice.address,
          hexWETH,
        );

        expect(aliceDepositAmount).to.equal(depositAmountInETH);
      });

      it('Place a borrowing order on the FIL market', async () => {
        await lendingMarketController
          .connect(alice)
          .createOrder(
            hexEFIL,
            filMaturities[0],
            Side.BORROW,
            orderAmountInFIL,
            '8000',
          );

        const aliceFV = await lendingMarketController.getFutureValue(
          hexEFIL,
          filMaturities[0],
          alice.address,
        );
        const unusedCollateral = await tokenVault.getUnusedCollateral(
          alice.address,
        );
        const coverage = await tokenVault.getCoverage(alice.address);

        expect(
          unusedCollateral.sub(depositAmountInETH.sub(orderAmountInETH)),
        ).lte(1);
        expect(aliceFV).to.equal('0');
        expect(coverage.sub('8000').abs()).lte(1);
      });

      it('Cancel an order', async () => {
        const {
          activeOrderIds: [orderId],
        } = await filLendingMarkets[0].getBorrowOrderIds(alice.address);

        await lendingMarketController
          .connect(alice)
          .cancelOrder(hexEFIL, filMaturities[0], orderId);

        const unusedCollateral = await tokenVault.getUnusedCollateral(
          alice.address,
        );
        const coverage = await tokenVault.getCoverage(alice.address);

        expect(unusedCollateral).to.equal(depositAmountInETH);
        expect(coverage).to.equal('0');
      });
    });

    describe('Place a lending order by a user who has a deposit, Cancel orders', async () => {
      const depositAmountInETH = initialETHBalance.div(5);
      const orderAmountInETH = depositAmountInETH.mul(4).div(5);
      const orderAmountInFIL = orderAmountInETH
        .mul(BigNumber.from(10).pow(18))
        .div(eFilToETHRate);

      before(async () => {
        [alice, bob, carol] = await getUsers(3);
        filMaturities = await lendingMarketController.getMaturities(hexEFIL);
        await createSampleFILOrders(carol);
      });

      it('Deposit ETH', async () => {
        await tokenVault.connect(alice).deposit(hexWETH, orderAmountInETH, {
          value: orderAmountInETH,
        });

        const aliceDepositAmount = await tokenVault.getDepositAmount(
          alice.address,
          hexWETH,
        );

        expect(aliceDepositAmount).to.equal(orderAmountInETH);
      });

      it('Place a lending order on the FIL market', async () => {
        await eFILToken
          .connect(alice)
          .approve(tokenVault.address, orderAmountInFIL);

        const totalCollateralAmountBefore =
          await tokenVault.getTotalCollateralAmount(alice.address);
        const depositAmountBefore = await tokenVault.getDepositAmount(
          alice.address,
          hexWETH,
        );

        await expect(
          lendingMarketController
            .connect(alice)
            .depositAndCreateOrder(
              hexEFIL,
              filMaturities[0],
              Side.LEND,
              orderAmountInFIL,
              '8000',
            ),
        ).to.not.emit(
          fundManagementLogic.attach(lendingMarketController.address),
          'OrderFilled',
        );

        const totalCollateralAmountAfter =
          await tokenVault.getTotalCollateralAmount(alice.address);
        const depositAmountAfter = await tokenVault.getDepositAmount(
          alice.address,
          hexWETH,
        );
        const aliceFV = await lendingMarketController.getFutureValue(
          hexEFIL,
          filMaturities[0],
          alice.address,
        );
        const unusedCollateral = await tokenVault.getUnusedCollateral(
          alice.address,
        );
        const coverage = await tokenVault.getCoverage(alice.address);

        expect(totalCollateralAmountBefore).to.equal(
          totalCollateralAmountAfter,
        );
        expect(depositAmountBefore).to.equal(depositAmountAfter);
        expect(unusedCollateral).to.equal(totalCollateralAmountBefore);
        expect(aliceFV).to.equal('0');
        expect(coverage).to.equal('0');
      });

      it('Cancel an order', async () => {
        const {
          activeOrderIds: [orderId],
        } = await filLendingMarkets[0].getLendOrderIds(alice.address);

        await lendingMarketController
          .connect(alice)
          .cancelOrder(hexEFIL, filMaturities[0], orderId);

        const filDepositAmount = await tokenVault.getDepositAmount(
          alice.address,
          hexEFIL,
        );
        const coverage = await tokenVault.getCoverage(alice.address);

        expect(filDepositAmount).to.equal(orderAmountInFIL);
        expect(coverage).to.equal('0');
      });
    });
  });
});
