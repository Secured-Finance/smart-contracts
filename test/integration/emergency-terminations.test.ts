import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber, Contract } from 'ethers';
import { ethers } from 'hardhat';

import { Side } from '../../utils/constants';
import { hexEFIL, hexETH, hexUSDC } from '../../utils/strings';
import { eFilToETHRate, usdcToETHRate } from '../common/constants';
import { deployContracts } from '../common/deployment';
import { Signers } from '../common/signers';

describe('Integration Test: Emergency terminations', async () => {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let dave: SignerWithAddress;

  let futureValueVaults: Contract[];
  let tokenVault: Contract;
  let lendingMarketController: Contract;
  let ethLendingMarkets: Contract[] = [];
  let filLendingMarkets: Contract[] = [];
  let wETHToken: Contract;
  let usdcToken: Contract;
  let eFILToken: Contract;
  let eFilToETHPriceFeed: Contract;

  let genesisDate: number;
  let maturities: BigNumber[];

  let signers: Signers;

  const initialUSDCBalance = BigNumber.from('10000000000');
  const initialFILBalance = BigNumber.from('100000000000000000000');
  const orderAmountInETH = BigNumber.from('100000000000000000');
  const orderAmountInUSDC = orderAmountInETH
    .mul(BigNumber.from(10).pow(6))
    .div(usdcToETHRate);
  const orderAmountInFIL = orderAmountInETH
    .mul(BigNumber.from(10).pow(18))
    .div(eFilToETHRate);

  const getUsers = async (count: number) =>
    signers.get(count, async (signer) => {
      await eFILToken
        .connect(owner)
        .transfer(signer.address, initialFILBalance);
      await usdcToken
        .connect(owner)
        .transfer(signer.address, initialUSDCBalance);
    });

  const createSampleETHOrders = async (
    user: SignerWithAddress,
    maturity: BigNumber,
    unitPrice: string,
  ) => {
    await tokenVault.connect(user).deposit(hexETH, orderAmountInETH, {
      value: orderAmountInETH,
    });

    await lendingMarketController
      .connect(user)
      .createOrder(
        hexETH,
        maturity,
        Side.BORROW,
        '1000000',
        BigNumber.from(unitPrice).add('1000'),
      );

    await lendingMarketController
      .connect(user)
      .createOrder(
        hexETH,
        maturity,
        Side.LEND,
        '1000000',
        BigNumber.from(unitPrice).sub('1000'),
      );
  };

  const createSampleFILOrders = async (
    user: SignerWithAddress,
    maturity: BigNumber,
    unitPrice: string,
  ) => {
    await eFILToken.connect(user).approve(tokenVault.address, orderAmountInETH);
    await tokenVault.connect(user).deposit(hexEFIL, orderAmountInETH);

    await lendingMarketController
      .connect(user)
      .createOrder(
        hexEFIL,
        maturity,
        Side.BORROW,
        '1000000',
        BigNumber.from(unitPrice).add('1000'),
      );

    await lendingMarketController
      .connect(user)
      .createOrder(
        hexEFIL,
        maturity,
        Side.LEND,
        '1000000',
        BigNumber.from(unitPrice).sub('1000'),
      );
  };

  const resetContractInstances = async () => {
    maturities = await lendingMarketController.getMaturities(hexETH);
    [ethLendingMarkets, filLendingMarkets, futureValueVaults] =
      await Promise.all([
        lendingMarketController
          .getLendingMarkets(hexETH)
          .then((addresses) =>
            Promise.all(
              addresses.map((address) =>
                ethers.getContractAt('LendingMarket', address),
              ),
            ),
          ),
        lendingMarketController
          .getLendingMarkets(hexEFIL)
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

  const initializeContracts = async () => {
    signers = new Signers(await ethers.getSigners());
    [owner] = await signers.get(1);

    ({
      genesisDate,
      tokenVault,
      lendingMarketController,
      wETHToken,
      eFILToken,
      usdcToken,
      eFilToETHPriceFeed,
    } = await deployContracts());

    await tokenVault.registerCurrency(hexETH, wETHToken.address, true);
    await tokenVault.registerCurrency(hexUSDC, usdcToken.address, true);
    await tokenVault.registerCurrency(hexEFIL, eFILToken.address, false);

    // Deploy active Lending Markets
    for (let i = 0; i < 8; i++) {
      await lendingMarketController.createLendingMarket(hexETH, genesisDate);
      await lendingMarketController.createLendingMarket(hexEFIL, genesisDate);
    }

    maturities = await lendingMarketController.getMaturities(hexETH);
  };

  describe('Execute emergency termination & redemption', async () => {
    describe('Including only healthy users', async () => {
      before(async () => {
        await initializeContracts();
        await resetContractInstances();
        [alice, bob, carol] = await getUsers(3);
      });

      it('Fill an order on the ETH market with depositing ETH', async () => {
        await tokenVault.connect(bob).deposit(hexETH, orderAmountInETH.mul(2), {
          value: orderAmountInETH.mul(2),
        });

        await expect(
          lendingMarketController
            .connect(bob)
            .createOrder(
              hexETH,
              maturities[0],
              Side.BORROW,
              orderAmountInETH,
              8000,
            ),
        ).to.emit(ethLendingMarkets[0], 'OrderMade');

        await expect(
          lendingMarketController
            .connect(alice)
            .depositAndCreateOrder(
              hexETH,
              maturities[0],
              Side.LEND,
              orderAmountInETH,
              0,
              { value: orderAmountInETH },
            ),
        ).to.emit(ethLendingMarkets[0], 'OrdersTaken');

        // Check future value
        const { futureValue: aliceFV } =
          await futureValueVaults[0].getFutureValue(alice.address);
        const { futureValue: bobFV } =
          await futureValueVaults[0].getFutureValue(bob.address);

        expect(aliceFV).not.to.equal('0');
        expect(bobFV).to.equal('0');
      });

      it('Fill an order on the FIL market with depositing USDC', async () => {
        await eFILToken
          .connect(alice)
          .approve(tokenVault.address, orderAmountInFIL);

        await usdcToken
          .connect(bob)
          .approve(tokenVault.address, orderAmountInUSDC.mul(2));
        await tokenVault
          .connect(bob)
          .deposit(hexUSDC, orderAmountInUSDC.mul(2));

        await expect(
          lendingMarketController
            .connect(bob)
            .createOrder(
              hexEFIL,
              maturities[0],
              Side.BORROW,
              orderAmountInFIL,
              8000,
            ),
        ).to.emit(filLendingMarkets[0], 'OrderMade');

        await expect(
          lendingMarketController
            .connect(alice)
            .depositAndCreateOrder(
              hexEFIL,
              maturities[0],
              Side.LEND,
              orderAmountInFIL,
              0,
            ),
        ).to.emit(filLendingMarkets[0], 'OrdersTaken');

        // Check future value
        const { futureValue: aliceFV } =
          await futureValueVaults[0].getFutureValue(alice.address);
        const { futureValue: bobFV } =
          await futureValueVaults[0].getFutureValue(bob.address);

        expect(aliceFV).not.to.equal('0');
        expect(bobFV).to.equal('0');
      });

      it('Execute emergency termination', async () => {
        await createSampleETHOrders(carol, maturities[0], '8000');
        await createSampleFILOrders(carol, maturities[0], '8000');

        await expect(
          lendingMarketController.executeEmergencyTermination(),
        ).to.emit(lendingMarketController, 'EmergencyTerminationExecuted');
      });

      it('Execute forced redemption', async () => {
        const aliceTotalPVBefore =
          await lendingMarketController.getTotalPresentValueInETH(
            alice.address,
          );
        const bobTotalPVBefore =
          await lendingMarketController.getTotalPresentValueInETH(bob.address);
        const bobTotalCollateralBefore =
          await tokenVault.getTotalCollateralAmount(bob.address);

        await expect(
          lendingMarketController
            .connect(alice)
            .executeRedemption(hexETH, hexETH),
        ).to.emit(lendingMarketController, 'RedemptionExecuted');

        await expect(
          lendingMarketController
            .connect(alice)
            .executeRedemption(hexEFIL, hexUSDC),
        ).to.emit(lendingMarketController, 'RedemptionExecuted');

        await expect(
          lendingMarketController
            .connect(bob)
            .executeRedemption(hexETH, hexETH),
        ).to.emit(lendingMarketController, 'RedemptionExecuted');

        await expect(
          lendingMarketController
            .connect(bob)
            .executeRedemption(hexEFIL, hexUSDC),
        )
          .to.emit(lendingMarketController, 'RedemptionExecuted')
          .withArgs(hexEFIL, bob.address, orderAmountInFIL.mul(-1));

        for (const user of [alice, bob]) {
          const fv = await lendingMarketController.getTotalPresentValueInETH(
            user.address,
          );
          expect(fv).equal(0);
        }

        const aliceTotalCollateralAfter =
          await tokenVault.getTotalCollateralAmount(alice.address);
        const bobTotalCollateralAfter =
          await tokenVault.getTotalCollateralAmount(bob.address);

        const roundedDecimals =
          orderAmountInETH.toString().length -
          orderAmountInUSDC.toString().length;

        expect(aliceTotalPVBefore.sub(aliceTotalCollateralAfter).abs()).to.lt(
          BigNumber.from(10).pow(roundedDecimals),
        );
        expect(
          bobTotalCollateralBefore
            .add(bobTotalPVBefore)
            .sub(bobTotalCollateralAfter),
        ).to.lt(BigNumber.from(10).pow(roundedDecimals));
      });

      it('Withdraw all collateral', async () => {
        for (const user of [alice, bob]) {
          const currencies = [hexETH, hexUSDC];

          const depositsBefore = await Promise.all(
            currencies.map((ccy) =>
              tokenVault.getDepositAmount(user.address, ccy),
            ),
          );

          await tokenVault.connect(user).withdraw(hexETH, depositsBefore[0]);
          await tokenVault.connect(user).withdraw(hexUSDC, depositsBefore[1]);

          await Promise.all(
            currencies.map((ccy) =>
              tokenVault
                .getDepositAmount(user.address, ccy)
                .then((deposit) => expect(deposit).equal(0)),
            ),
          );
        }
      });
    });

    describe('Including a liquidation user', async () => {
      before(async () => {
        await initializeContracts();
        await resetContractInstances();
        [alice, bob, carol] = await getUsers(3);
      });

      it('Fill an order on the ETH market with depositing ETH', async () => {
        await tokenVault.connect(bob).deposit(hexETH, orderAmountInETH.mul(2), {
          value: orderAmountInETH.mul(2),
        });

        await expect(
          lendingMarketController
            .connect(bob)
            .createOrder(
              hexETH,
              maturities[0],
              Side.BORROW,
              orderAmountInETH,
              8000,
            ),
        ).to.emit(ethLendingMarkets[0], 'OrderMade');

        await expect(
          lendingMarketController
            .connect(alice)
            .depositAndCreateOrder(
              hexETH,
              maturities[0],
              Side.LEND,
              orderAmountInETH,
              0,
              { value: orderAmountInETH },
            ),
        ).to.emit(ethLendingMarkets[0], 'OrdersTaken');
      });

      it('Fill an order on the FIL market with depositing USDC', async () => {
        await eFILToken
          .connect(alice)
          .approve(tokenVault.address, orderAmountInFIL);

        await usdcToken
          .connect(bob)
          .approve(tokenVault.address, orderAmountInUSDC.div(5));
        await tokenVault
          .connect(bob)
          .deposit(hexUSDC, orderAmountInUSDC.div(5));

        await expect(
          lendingMarketController
            .connect(bob)
            .createOrder(
              hexEFIL,
              maturities[0],
              Side.BORROW,
              orderAmountInFIL.div(10),
              8000,
            ),
        ).to.emit(filLendingMarkets[0], 'OrderMade');

        await expect(
          lendingMarketController
            .connect(alice)
            .depositAndCreateOrder(
              hexEFIL,
              maturities[0],
              Side.LEND,
              orderAmountInFIL.div(10),
              0,
            ),
        ).to.emit(filLendingMarkets[0], 'OrdersTaken');
      });

      it('Update a price feed to change the eFIL price', async () => {
        await createSampleETHOrders(carol, maturities[0], '8000');
        await createSampleFILOrders(carol, maturities[0], '8000');

        const coverageBefore = await tokenVault.getCoverage(bob.address);
        expect(coverageBefore).lt('8000');

        await eFilToETHPriceFeed.updateAnswer(eFilToETHRate.mul(20));

        const coverageAfter = await tokenVault.getCoverage(bob.address);
        expect(coverageAfter).gte('8000');
      });

      it('Execute emergency termination', async () => {
        await expect(
          lendingMarketController.executeEmergencyTermination(),
        ).to.emit(lendingMarketController, 'EmergencyTerminationExecuted');
      });

      it('Execute forced redemption', async () => {
        await expect(
          lendingMarketController
            .connect(alice)
            .executeRedemption(hexETH, hexETH),
        ).to.emit(lendingMarketController, 'RedemptionExecuted');

        await expect(
          lendingMarketController
            .connect(alice)
            .executeRedemption(hexEFIL, hexUSDC),
        ).to.emit(lendingMarketController, 'RedemptionExecuted');

        await expect(
          lendingMarketController
            .connect(bob)
            .executeRedemption(hexETH, hexETH),
        ).to.emit(lendingMarketController, 'RedemptionExecuted');

        await expect(
          lendingMarketController
            .connect(bob)
            .executeRedemption(hexEFIL, hexETH),
        ).to.emit(lendingMarketController, 'RedemptionExecuted');

        for (const user of [alice, bob]) {
          const fv = await lendingMarketController.getTotalPresentValueInETH(
            user.address,
          );
          expect(fv).equal(0);
        }
      });
    });

    describe('Including an insolvent user', async () => {
      before(async () => {
        await initializeContracts();
        await resetContractInstances();
        [alice, bob, carol, dave] = await getUsers(4);
      });

      it('Fill an order on the ETH market with depositing ETH', async () => {
        await tokenVault.connect(bob).deposit(hexETH, orderAmountInETH.mul(2), {
          value: orderAmountInETH.mul(2),
        });

        await expect(
          lendingMarketController
            .connect(bob)
            .createOrder(
              hexETH,
              maturities[0],
              Side.BORROW,
              orderAmountInETH,
              8000,
            ),
        ).to.emit(ethLendingMarkets[0], 'OrderMade');

        await expect(
          lendingMarketController
            .connect(alice)
            .depositAndCreateOrder(
              hexETH,
              maturities[0],
              Side.LEND,
              orderAmountInETH,
              0,
              { value: orderAmountInETH },
            ),
        ).to.emit(ethLendingMarkets[0], 'OrdersTaken');
      });

      it('Fill an order on the FIL market with depositing USDC', async () => {
        await eFILToken
          .connect(alice)
          .approve(tokenVault.address, orderAmountInFIL);

        await usdcToken
          .connect(bob)
          .approve(tokenVault.address, orderAmountInUSDC.mul(2));
        await tokenVault
          .connect(bob)
          .deposit(hexUSDC, orderAmountInUSDC.mul(2));

        await expect(
          lendingMarketController
            .connect(bob)
            .createOrder(
              hexEFIL,
              maturities[0],
              Side.BORROW,
              orderAmountInFIL,
              8000,
            ),
        ).to.emit(filLendingMarkets[0], 'OrderMade');

        await expect(
          lendingMarketController
            .connect(alice)
            .depositAndCreateOrder(
              hexEFIL,
              maturities[0],
              Side.LEND,
              orderAmountInFIL,
              0,
            ),
        ).to.emit(filLendingMarkets[0], 'OrdersTaken');
      });

      it('Fill an order for a huge amount to store fees in the reserve funds', async () => {
        await tokenVault
          .connect(carol)
          .deposit(hexETH, orderAmountInETH.mul(2000), {
            value: orderAmountInETH.mul(2000),
          });

        await expect(
          lendingMarketController
            .connect(carol)
            .createOrder(
              hexETH,
              maturities[0],
              Side.BORROW,
              orderAmountInETH.mul(1000),
              8000,
            ),
        ).to.emit(ethLendingMarkets[0], 'OrderMade');

        await expect(
          lendingMarketController
            .connect(dave)
            .depositAndCreateOrder(
              hexETH,
              maturities[0],
              Side.LEND,
              orderAmountInETH.mul(1000),
              0,
              { value: orderAmountInETH.mul(1000) },
            ),
        ).to.emit(ethLendingMarkets[0], 'OrdersTaken');
      });

      it('Update a price feed to change the eFIL price', async () => {
        await createSampleETHOrders(carol, maturities[0], '8000');
        await createSampleFILOrders(carol, maturities[0], '8000');

        const coverageBefore = await tokenVault.getCoverage(bob.address);
        expect(coverageBefore).lt('8000');

        await eFilToETHPriceFeed.updateAnswer(eFilToETHRate.mul(5));

        const coverageAfter = await tokenVault.getCoverage(bob.address);
        expect(coverageAfter).gte('8000');
      });

      it('Execute emergency termination', async () => {
        await expect(
          lendingMarketController.executeEmergencyTermination(),
        ).to.emit(lendingMarketController, 'EmergencyTerminationExecuted');
      });

      it('Execute forced redemption', async () => {
        await expect(
          lendingMarketController
            .connect(alice)
            .executeRedemption(hexETH, hexETH),
        ).to.emit(lendingMarketController, 'RedemptionExecuted');

        await expect(
          lendingMarketController
            .connect(alice)
            .executeRedemption(hexEFIL, hexUSDC),
        ).to.emit(lendingMarketController, 'RedemptionExecuted');

        await expect(
          lendingMarketController
            .connect(bob)
            .executeRedemption(hexETH, hexETH),
        ).to.emit(lendingMarketController, 'RedemptionExecuted');

        await expect(
          lendingMarketController
            .connect(bob)
            .executeRedemption(hexEFIL, hexETH),
        ).to.revertedWith('Not enough collateral');
      });
    });
  });
});
