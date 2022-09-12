import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { time } from '@openzeppelin/test-helpers';
import { expect } from 'chai';
import { BigNumber, Contract } from 'ethers';
import { ethers, web3 } from 'hardhat';

import { Side } from '../utils/constants';
import { deployContracts } from '../utils/deployment';
import { filToETHRate, toBN } from '../utils/numbers';
import { hexETHString, hexFILString } from '../utils/strings';

const toWei = (eth) => {
  return ethers.utils.parseEther(eth);
};

describe('Integration test', async () => {
  let ownerSigner: SignerWithAddress;
  let aliceSigner: SignerWithAddress;
  let bobSigner: SignerWithAddress;
  let carolSigner: SignerWithAddress;

  const targetCurrency = hexETHString;

  let tokenVault: Contract;
  let currencyController: Contract;
  let lendingMarketController: Contract;
  let wETHToken: Contract;
  let wFILToken: Contract;
  let filToETHPriceFeed: Contract;

  let lendingMarkets: Contract[] = [];
  let ethLendingMarkets: Contract[] = [];

  let aliceCollateralAmount = toBN('0');
  let carolInitialCollateral = toBN('100000000000000000000');

  let orderAmountInETH = toBN('10000000000');

  before('Deploy Contracts', async () => {
    [ownerSigner, aliceSigner, bobSigner, carolSigner] =
      await ethers.getSigners();

    ({
      tokenVault,
      currencyController,
      lendingMarketController,
      wETHToken,
      wFILToken,
      filToETHPriceFeed,
    } = await deployContracts());

    await tokenVault.registerCurrency(hexETHString, wETHToken.address);

    await tokenVault.registerCurrency(hexFILString, wFILToken.address);

    await wFILToken
      .connect(ownerSigner)
      .transfer(aliceSigner.address, '1000000000000000000000');
    await wFILToken
      .connect(ownerSigner)
      .transfer(bobSigner.address, '1000000000000000000000');
    await wFILToken
      .connect(ownerSigner)
      .transfer(carolSigner.address, '1000000000000000000000');

    // Deploy Lending Markets for FIL market
    for (let i = 0; i < 4; i++) {
      await lendingMarketController
        .createLendingMarket(hexFILString)
        .then((tx) => tx.wait());
    }

    lendingMarkets = await lendingMarketController
      .getLendingMarkets(hexFILString)
      .then((addresses: string[]) =>
        Promise.all(
          addresses.map((address) =>
            ethers.getContractAt('LendingMarket', address),
          ),
        ),
      );

    // Deploy Lending Markets for ETH market
    for (let i = 0; i < 4; i++) {
      await lendingMarketController
        .createLendingMarket(hexETHString)
        .then((tx) => tx.wait());
    }

    ethLendingMarkets = await lendingMarketController
      .getLendingMarkets(hexETHString)
      .then((addresses) =>
        Promise.all(
          addresses.map((address) =>
            ethers.getContractAt('LendingMarket', address),
          ),
        ),
      );
  });

  describe('Prepare markets and users for lending deals', async () => {
    it('Register collateral for Carol with 90 ETH and check Carol collateral', async () => {
      let actualBalance = await wETHToken.balanceOf(tokenVault.address);
      expect(actualBalance.toString()).to.equal('0');

      await tokenVault
        .connect(carolSigner)
        .deposit(targetCurrency, carolInitialCollateral.toString(), {
          value: carolInitialCollateral.toString(),
        })
        .then((tx) => tx.wait());

      expect(await wETHToken.balanceOf(tokenVault.address)).to.equal(
        carolInitialCollateral,
      );

      actualBalance = await wETHToken.balanceOf(tokenVault.address);
      expect(actualBalance.toString()).to.equal(
        carolInitialCollateral.toString(),
      );

      let currencies = await tokenVault.getUsedCurrencies(carolSigner.address);
      expect(currencies.includes(targetCurrency)).to.equal(true);

      let collateralAmount = await tokenVault.getCollateralAmount(
        carolSigner.address,
        targetCurrency,
      );
      expect(collateralAmount.toString()).to.equal(
        carolInitialCollateral.toString(),
      );

      const totalPresentValue =
        await lendingMarketController.getTotalPresentValue(
          targetCurrency,
          carolSigner.address,
        );
      expect(totalPresentValue).to.equal('0');
    });

    it('Make lend orders by Carol', async () => {
      const maturities: BigNumber[] =
        await lendingMarketController.getMaturities(hexFILString);
      const ethMaturities: BigNumber[] =
        await lendingMarketController.getMaturities(hexETHString);

      await wFILToken
        .connect(carolSigner)
        .approve(tokenVault.address, '300000000000000000000')
        .then((tx) => tx.wait());

      const initialAmount = 30;
      const initialRate = 920;
      for (const [idx, maturity] of maturities.entries()) {
        await expect(
          lendingMarketController
            .connect(carolSigner)
            .createOrder(
              hexFILString,
              maturity,
              Side.LEND,
              toWei(String(initialAmount + idx)),
              String(initialRate + 100 * idx),
            ),
        ).to.emit(lendingMarkets[idx], 'MakeOrder');
      }

      const initialRateETH = 300;
      for (const [idx, maturity] of ethMaturities.entries()) {
        await expect(
          lendingMarketController
            .connect(carolSigner)
            .createLendOrderWithETH(
              hexETHString,
              maturity,
              String(initialRateETH + 10 * idx),
              {
                value: orderAmountInETH,
              },
            ),
        ).to.emit(ethLendingMarkets[idx], 'MakeOrder');
      }
    });

    it('Make borrow orders by Carol', async () => {
      const maturities = await lendingMarketController.getMaturities(
        hexFILString,
      );
      const ethMaturities = await lendingMarketController.getMaturities(
        hexETHString,
      );

      const lendingMarkets = await lendingMarketController
        .getLendingMarkets(hexFILString)
        .then((addresses) =>
          Promise.all(
            addresses.map((address) =>
              ethers.getContractAt('LendingMarket', address),
            ),
          ),
        );
      const ethLendingMarkets = await lendingMarketController
        .getLendingMarkets(hexETHString)
        .then((addresses) =>
          Promise.all(
            addresses.map((address) =>
              ethers.getContractAt('LendingMarket', address),
            ),
          ),
        );

      const initialAmount = 30;
      const initialRate = 680;
      for (const [idx, maturity] of maturities.entries()) {
        await expect(
          lendingMarketController
            .connect(carolSigner)
            .createOrder(
              hexFILString,
              maturity,
              Side.BORROW,
              toWei(String(initialAmount + idx)),
              String(initialRate + 100 * idx),
            ),
        ).to.emit(lendingMarkets[idx], 'MakeOrder');
      }

      const initialRateETH = 270;
      for (const [idx, maturity] of ethMaturities.entries()) {
        await expect(
          lendingMarketController
            .connect(carolSigner)
            .createOrder(
              hexETHString,
              maturity,
              Side.BORROW,
              orderAmountInETH,
              String(initialRateETH + 10 * idx),
            ),
        ).to.emit(ethLendingMarkets[idx], 'MakeOrder');
      }
    });
  });

  describe('Test Deposit and Withdraw collateral by Alice', async () => {
    it('Deposit 10 ETH by Alice in Collateral contract', async () => {
      let depositAmount = toBN('10000000000000000000');

      await tokenVault
        .connect(aliceSigner)
        .deposit(targetCurrency, depositAmount.toString(), {
          value: depositAmount.toString(),
        })
        .then((tx) => tx.wait());

      expect(await wETHToken.balanceOf(tokenVault.address)).to.equal(
        carolInitialCollateral.add(depositAmount).add(orderAmountInETH.mul(4)),
      );

      let currencies = await tokenVault.getUsedCurrencies(aliceSigner.address);
      expect(currencies.includes(targetCurrency)).to.equal(true);

      let collateralAmount = await tokenVault.getCollateralAmount(
        aliceSigner.address,
        targetCurrency,
      );
      expect(collateralAmount.toString()).to.equal(depositAmount.toString());

      aliceCollateralAmount = depositAmount;
    });

    it('Deposit 13.5252524 ETH by Alice in Collateral contract', async () => {
      let depositAmount = toBN('13525252400000000000');

      await tokenVault
        .connect(aliceSigner)
        .deposit(targetCurrency, depositAmount.toString(), {
          value: depositAmount.toString(),
        })
        .then((tx) => tx.wait());

      aliceCollateralAmount = aliceCollateralAmount.add(depositAmount);

      let collateralAmount = await tokenVault.getCollateralAmount(
        aliceSigner.address,
        targetCurrency,
      );

      expect(collateralAmount.toString()).to.equal(
        aliceCollateralAmount.toString(),
      );
    });

    it('Try to Withdraw 30 ETH from Collateral by Alice but withdraw maximum amount of independent collateral, ', async () => {
      let withdrawal = toBN('30000000000000000000');
      await tokenVault
        .connect(aliceSigner)
        .withdraw(targetCurrency, withdrawal.toString())
        .then((tx) => tx.wait());

      let collateralAmount = await tokenVault.getCollateralAmount(
        aliceSigner.address,
        targetCurrency,
      );

      expect(collateralAmount.toString()).to.equal('0');

      aliceCollateralAmount = aliceCollateralAmount.sub(aliceCollateralAmount);
    });

    it('Register collateral by Bob with 1 ETH deposit', async () => {
      let depositAmount = toBN('1000000000000000000');

      await tokenVault
        .connect(bobSigner)
        .deposit(targetCurrency, depositAmount.toString(), {
          value: depositAmount.toString(),
        })
        .then((tx) => tx.wait());

      let currencies = await tokenVault.getUsedCurrencies(bobSigner.address);
      expect(currencies.includes(targetCurrency)).to.equal(true);

      let collateralAmount = await tokenVault.getCollateralAmount(
        bobSigner.address,
        targetCurrency,
      );
      expect(collateralAmount.toString()).to.equal(depositAmount.toString());
    });

    it('Deposit 2 ETH by Bob in Collateral contract', async () => {
      let depositAmount = toBN('2000000000000000000');
      await tokenVault
        .connect(bobSigner)
        .deposit(targetCurrency, depositAmount.toString(), {
          value: depositAmount.toString(),
        })
        .then((tx) => tx.wait());

      let collateralAmount = await tokenVault.getCollateralAmount(
        bobSigner.address,
        targetCurrency,
      );

      expect(collateralAmount.toString()).to.equal('3000000000000000000');
    });

    it('Try to withdraw 1 ETH from empty collateral book by Alice, expect no change in Alice balance', async () => {
      let withdrawal = toBN('1000000000000000000');

      await tokenVault
        .connect(aliceSigner)
        .withdraw(targetCurrency, withdrawal.toString())
        .then((tx) => tx.wait());
    });
  });

  describe('Test making new orders on FIL LendingMarket, and check collateral usage', async () => {
    const orderAmount = '1000000000000000000';
    const depositAmount = '1500000000000000000';
    let orderAmountInFIL: string;
    let maturities: BigNumber[];

    before(async () => {
      orderAmountInFIL = await currencyController
        .connect(aliceSigner)
        .convertFromETH(hexFILString, orderAmount);

      maturities = await lendingMarketController.getMaturities(hexFILString);
    });

    it('Deposit 1 ETH by Alice in Collateral contract', async () => {
      await tokenVault
        .connect(aliceSigner)
        .deposit(targetCurrency, depositAmount, {
          value: depositAmount,
        })
        .then((tx) => tx.wait());

      aliceCollateralAmount = aliceCollateralAmount.add(depositAmount);

      let collateralAmount = await tokenVault.getCollateralAmount(
        aliceSigner.address,
        targetCurrency,
      );

      expect(collateralAmount.toString()).to.equal(
        aliceCollateralAmount.toString(),
      );
    });

    it('Expect revert on making order for 100 FIL', async () => {
      let depositAmountInFIL = await currencyController
        .connect(aliceSigner)
        .convertFromETH(hexFILString, depositAmount);

      await expect(
        lendingMarketController
          .connect(aliceSigner)
          .createOrder(
            hexFILString,
            maturities[0],
            Side.BORROW,
            depositAmountInFIL,
            '700',
          ),
      ).to.be.revertedWith('Not enough collateral');
    });

    it('Successfully make order for 10 FIL', async () => {
      await expect(
        lendingMarketController
          .connect(aliceSigner)
          .createOrder(
            hexFILString,
            maturities[0],
            Side.BORROW,
            orderAmountInFIL,
            '725',
          ),
      ).to.emit(lendingMarkets[0], 'MakeOrder');
    });

    it('Check Alice collateral book usage, and total unsettled exposure calculations', async () => {
      let orderAmountInETH = await currencyController
        .connect(aliceSigner)
        ['convertToETH(bytes32,uint256)'](hexFILString, orderAmountInFIL);

      let exp = await tokenVault.getTotalUnsettledExposure(aliceSigner.address);
      expect(exp.toString()).to.equal(orderAmountInETH.toString());

      let collateralAmount = await tokenVault.getCollateralAmount(
        aliceSigner.address,
        targetCurrency,
      );
      expect(collateralAmount.toString()).to.equal(
        aliceCollateralAmount.toString(),
      );
    });

    it('Calculate collateral coverage of the global collateral book, expect to be equal with manual calculations', async () => {
      let collateralAmount = await tokenVault.getCollateralAmount(
        aliceSigner.address,
        targetCurrency,
      );
      expect(collateralAmount.toString()).to.equal(
        aliceCollateralAmount.toString(),
      );

      let coverage = await tokenVault.getCoverage(aliceSigner.address);

      const totalUnsettledExp = await tokenVault.getTotalUnsettledExposure(
        aliceSigner.address,
      );

      let manualCoverage = ethers.BigNumber.from(totalUnsettledExp.toString())
        .mul('10000')
        .div(collateralAmount.toString());

      expect(coverage.toNumber()).to.equal(manualCoverage.toNumber());
    });

    it('Expect withdrawing maximum available amount instead of withdrawing 0.9 ETH by Alice', async () => {
      let withdrawal = toBN('900000000000000000');
      let maxWithdrawal = await tokenVault.getWithdrawableCollateral(
        aliceSigner.address,
      );

      await tokenVault
        .connect(aliceSigner)
        .withdraw(targetCurrency, withdrawal.toString())
        .then((tx) => tx.wait());

      aliceCollateralAmount = aliceCollateralAmount.sub(maxWithdrawal);

      let collateralAmount = await tokenVault.getCollateralAmount(
        aliceSigner.address,
        targetCurrency,
      );
      expect(collateralAmount.toString()).to.equal(
        aliceCollateralAmount.toString(),
      );
    });

    it('Expect withdrawing 0 instead of withdrawing 0.1 ETH by Alice', async () => {
      let maxWithdrawal = await tokenVault.getWithdrawableCollateral(
        aliceSigner.address,
      );
      let withdrawal = toBN('100000000000000000');

      (
        await tokenVault
          .connect(aliceSigner)
          .withdraw(targetCurrency, withdrawal.toString())
      ).wait();

      aliceCollateralAmount = await aliceCollateralAmount.sub(maxWithdrawal);

      let collateralAmount = await tokenVault.getCollateralAmount(
        aliceSigner.address,
        targetCurrency,
      );

      expect(collateralAmount.toString()).to.equal(
        aliceCollateralAmount.toString(),
      );
    });
  });

  describe('Test release collateral functions by canceling lending orders FIL', async () => {
    it('Successfully cancel order for FIL', async () => {
      const maturities: BigNumber[] =
        await lendingMarketController.getMaturities(hexFILString);

      let tx = await lendingMarketController
        .connect(aliceSigner)
        .cancelOrder(hexFILString, maturities[0], '3');

      await expect(tx).to.emit(lendingMarkets[0], 'CancelOrder');
      await tx.wait();

      const totalUnsettledExp = await tokenVault.getTotalUnsettledExposure(
        aliceSigner.address,
      );
      expect(totalUnsettledExp.toString()).to.be.equal('0');

      let maxWithdrawal = await tokenVault.getWithdrawableCollateral(
        aliceSigner.address,
      );

      expect(maxWithdrawal.toString()).to.equal(
        aliceCollateralAmount.toString(),
      );
    });

    it('Successfully cancel order for ETH', async () => {
      let orderAmount = toBN('100000000000000000000');
      const balanceBefore = await web3.eth.getBalance(carolSigner.address);

      const ethMaturities: BigNumber[] =
        await lendingMarketController.getMaturities(hexETHString);

      const receipt = await lendingMarketController
        .connect(carolSigner)
        .createLendOrderWithETH(hexETHString, ethMaturities[0], '200', {
          value: orderAmount,
        })
        .then((tx) => tx.wait());

      const balanceAfterOrder = await web3.eth.getBalance(carolSigner.address);
      expect(
        toBN(balanceBefore).sub(orderAmount).gt(balanceAfterOrder),
      ).to.equal(true);

      const { orderId } = receipt.events.find(
        ({ event }) => event === 'OrderPlaced',
      ).args;

      await expect(
        lendingMarketController
          .connect(carolSigner)
          .cancelOrder(hexETHString, ethMaturities[0], orderId),
      ).to.emit(lendingMarketController, 'OrderCanceled');

      const balanceAfterCancel = await web3.eth.getBalance(carolSigner.address);
      expect(toBN(balanceAfterCancel).gt(balanceAfterOrder)).to.equal(true);
    });

    it('Successfully withdraw left collateral by Alice', async () => {
      let maxWithdrawal = await tokenVault.getWithdrawableCollateral(
        aliceSigner.address,
      );

      aliceCollateralAmount = aliceCollateralAmount.sub(maxWithdrawal);

      await tokenVault
        .connect(aliceSigner)
        .withdraw(targetCurrency, maxWithdrawal.toString())
        .then((tx) => tx.wait());

      let collateralAmount = await tokenVault.getCollateralAmount(
        aliceSigner.address,
        targetCurrency,
      );

      expect(collateralAmount.toString()).to.equal('0');
    });
  });

  describe('Test making new orders on FIL LendingMarket by Alice, and taking orders by Bob', async () => {
    let orderAmountInFIL = '30000000000000000000';
    let rate = '725';

    it('Deposit 1 ETH by Alice in Collateral contract', async () => {
      let depositAmount = toBN('1000000000000000000');

      await tokenVault
        .connect(aliceSigner)
        .deposit(targetCurrency, depositAmount.toString(), {
          value: depositAmount.toString(),
        })
        .then((tx) => tx.wait());

      aliceCollateralAmount = aliceCollateralAmount.add(depositAmount);

      let collateralAmount = await tokenVault.getCollateralAmount(
        aliceSigner.address,
        targetCurrency,
      );

      expect(collateralAmount.toString()).to.equal(
        aliceCollateralAmount.toString(),
      );
    });

    it('Successfully make order for 30 FIL by Alice, take this order by Bob', async () => {
      const aliceFILBalance: BigNumber = await wFILToken.balanceOf(
        aliceSigner.address,
      );
      const bobFILBalance: BigNumber = await wFILToken.balanceOf(
        bobSigner.address,
      );

      await wFILToken
        .connect(aliceSigner)
        .approve(tokenVault.address, orderAmountInFIL)
        .then((tx) => tx.wait());

      const maturities = await lendingMarketController.getMaturities(
        hexFILString,
      );

      let depositAmount = toBN('1000000000000000000');
      await expect(
        lendingMarketController
          .connect(aliceSigner)
          .createOrder(
            hexFILString,
            maturities[0],
            Side.LEND,
            orderAmountInFIL,
            rate,
          ),
      ).to.emit(lendingMarkets[0], 'MakeOrder');

      expect(aliceFILBalance.sub(orderAmountInFIL)).to.equal(
        await wFILToken.balanceOf(aliceSigner.address),
      );

      await tokenVault
        .connect(bobSigner)
        .deposit(targetCurrency, depositAmount.toString(), {
          value: depositAmount.toString(),
        })
        .then((tx) => tx.wait());

      let filInETH = await currencyController
        .connect(aliceSigner)
        ['convertToETH(bytes32,uint256)'](hexFILString, orderAmountInFIL);
      console.log('FIL in ETH is: ' + filInETH);
      console.log('Taking order for 30 FIL, and using collateral');

      await expect(
        lendingMarketController
          .connect(bobSigner)
          .createOrder(
            hexFILString,
            maturities[0],
            Side.BORROW,
            orderAmountInFIL,
            rate,
          ),
      ).to.emit(lendingMarkets[0], 'TakeOrder');

      expect(aliceFILBalance.sub(orderAmountInFIL)).to.equal(
        await wFILToken.balanceOf(aliceSigner.address),
      );
      expect(bobFILBalance.add(orderAmountInFIL)).to.equal(
        await wFILToken.balanceOf(bobSigner.address),
      );

      const collateralAmountAlice = await tokenVault.getCollateralAmount(
        aliceSigner.address,
        targetCurrency,
      );
      const collateralAmountBob = await tokenVault.getCollateralAmount(
        bobSigner.address,
        targetCurrency,
      );

      const maxWithdrawalAlice = await tokenVault.getWithdrawableCollateral(
        aliceSigner.address,
      );
      const maxWithdrawalBob = await tokenVault.getWithdrawableCollateral(
        bobSigner.address,
      );

      const totalPresentValueBob =
        await lendingMarketController.getTotalPresentValueInETH(
          bobSigner.address,
        );

      expect(maxWithdrawalAlice.toString()).to.equal(
        collateralAmountAlice.toString(),
      );
      expect(maxWithdrawalBob.toString()).to.equal(
        collateralAmountBob
          .mul('10')
          .add(totalPresentValueBob.mul('15'))
          .div('10')
          .toString(),
      );

      const bobCoverage = await tokenVault.getCoverage(bobSigner.address);
      const aliceCoverage = await tokenVault.getCoverage(aliceSigner.address);

      console.group('Collateral coverage for:');
      console.log('Bob (borrower) of 30 FIL is ' + bobCoverage.toString());
      console.log('Alice (lender) of 30 FIL is ' + aliceCoverage.toString());
      console.groupEnd();
    });
  });

  describe('Test second loan by Alice and Bob for 1 ETH', async () => {
    let rate = '800';
    let ethAmount = '1000000000000000000';

    it('Deposit 45 ETH by Alice in Collateral contract', async () => {
      const depositAmount = toBN('45000000000000000000');

      await tokenVault
        .connect(aliceSigner)
        .deposit(targetCurrency, depositAmount.toString(), {
          value: depositAmount.toString(),
        })
        .then((tx) => tx.wait());

      aliceCollateralAmount = aliceCollateralAmount.add(depositAmount);

      const collateralAmount = await tokenVault.getCollateralAmount(
        aliceSigner.address,
        targetCurrency,
      );

      expect(collateralAmount.toString()).to.equal(
        aliceCollateralAmount.toString(),
      );

      const totalPresentValue =
        await lendingMarketController.getTotalPresentValue(
          targetCurrency,
          aliceSigner.address,
        );
      expect(totalPresentValue).to.equal('0');
    });

    it('Successfully make order for 1 ETH by Bob, deposit 15 ETH by Bob, take this order by Alice', async () => {
      let depositAmount = toBN('15000000000000000000');
      const maturities = await lendingMarketController.getMaturities(
        hexETHString,
      );

      await tokenVault
        .connect(bobSigner)
        .deposit(targetCurrency, depositAmount.toString(), {
          value: depositAmount.toString(),
        })
        .then((tx) => tx.wait());

      console.log('Making a new order to lend 1 ETH for 5 years by Bob');

      await expect(
        lendingMarketController
          .connect(bobSigner)
          .createLendOrderWithETH(hexETHString, maturities[0], rate, {
            value: ethAmount,
          }),
      ).to.emit(ethLendingMarkets[0], 'MakeOrder');

      console.log(
        'Taking order for 1 ETH, and using collateral by Alice as a borrower',
      );

      await expect(
        lendingMarketController
          .connect(aliceSigner)
          .createOrder(
            hexETHString,
            maturities[0],
            Side.BORROW,
            ethAmount,
            rate,
          ),
      ).to.emit(ethLendingMarkets[0], 'TakeOrder');

      const totalPresentValue =
        await lendingMarketController.getTotalPresentValue(
          targetCurrency,
          aliceSigner.address,
        );

      aliceCollateralAmount = aliceCollateralAmount.sub(
        toBN(totalPresentValue),
      );

      console.log('ETH is: ' + ethAmount);

      const bobCoverage = await tokenVault.getCoverage(bobSigner.address);
      const aliceCoverage = await tokenVault.getCoverage(aliceSigner.address);
      console.group('Collateral coverage for:');
      console.log('Bob (lender) of 1 ETH is ' + bobCoverage.toString());
      console.log('Alice (borrower) of 1 ETH is ' + aliceCoverage.toString());
      console.groupEnd();
    });

    it('Shift time by 3 month', async () => {
      const totalPresentValue =
        await lendingMarketController.getTotalPresentValue(
          hexETHString,
          bobSigner.address,
        );
      console.log('totalPresentValue:', totalPresentValue);

      await time.increase(time.duration.days(92));

      const bobCoverage = await tokenVault.getCoverage(bobSigner.address);
      const aliceCoverage = await tokenVault.getCoverage(aliceSigner.address);
      console.group('Collateral coverage for:');
      console.log('Bob (lender) of 1 ETH is ' + bobCoverage.toString());
      console.log('Alice (borrower) of 1 ETH is ' + aliceCoverage.toString());
      console.groupEnd();

      const totalPresentValue2 =
        await lendingMarketController.getTotalPresentValue(
          hexETHString,
          bobSigner.address,
        );
      console.log('totalPresentValue2:', totalPresentValue2);
    });

    describe('Test Liquidations for registered loans', async () => {
      it('Increase FIL exchange rate by 25%, check collateral coverage', async () => {
        const newPrice = filToETHRate.mul('125').div('100');
        await filToETHPriceFeed.updateAnswer(newPrice);

        const bobCoverage = await tokenVault.getCoverage(bobSigner.address);
        const aliceCoverage = await tokenVault.getCoverage(aliceSigner.address);

        console.group('Collateral coverage for:');
        console.log(
          'Bob (lender) of 1 ETH and borrower of 30 FIL is ' +
            bobCoverage.toString(),
        );
        console.log(
          'Alice (borrower) of 1 ETH and lender of 30 FIL is ' +
            aliceCoverage.toString(),
        );
        console.groupEnd();
      });
    });
  });
});
