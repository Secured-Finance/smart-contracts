const CollateralAggregator = artifacts.require('CollateralAggregator');
const LendingMarket = artifacts.require('LendingMarket');
const MockV3Aggregator = artifacts.require('MockV3Aggregator');

const { should } = require('chai');
const { expectEvent, expectRevert } = require('@openzeppelin/test-helpers');

const { zeroAddress } = require('../test-utils/src/strings');
should();

const { hexFILString, loanPrefix } = require('../test-utils').strings;
const { termDays, sortedTermDays } = require('../test-utils').terms;
const { Deployment } = require('../test-utils').deployment;
const { orders } = require('./orders');

contract('LendingMarketController', async (accounts) => {
  const [owner, alice, bob, carol] = accounts;
  const filRate = web3.utils.toBN('67175250000000000');
  let filToETHPriceFeed;

  let currencyController;
  let collateralAggregator;
  let loan;
  let lendingMarketController;
  let lendingMarkets = [];
  let orderList;
  let productAddressResolver;
  let termStructure;

  before('deploy LendingMarketController', async () => {
    collateralAggregator = await CollateralAggregator.new();

    const deployment = new Deployment();
    // TODO: Need to update to V2
    deployment.mock('CollateralAggregator').useValue(collateralAggregator);
    ({
      dealIdLibrary,
      closeOutNetting,
      currencyController,
      crosschainAddressResolver,
      termStructure,
      productAddressResolver,
      settlementEngine,
      lendingMarketController,
      loan,
    } = await deployment.execute());

    filToETHPriceFeed = await MockV3Aggregator.new(18, hexFILString, filRate);
    let tx = await currencyController.supportCurrency(
      hexFILString,
      'Filecoin',
      461,
      filToETHPriceFeed.address,
      7500,
      zeroAddress,
    );
    expectEvent(tx, 'CcyAdded');

    await collateralAggregator.setCurrencyController(
      currencyController.address,
      {
        from: owner,
      },
    );

    orderList = orders;

    await productAddressResolver.registerProduct(
      loanPrefix,
      loan.address,
      lendingMarketController.address,
    );

    for (i = 0; i < termDays.length; i++) {
      await termStructure.supportTerm(
        termDays[i],
        [loanPrefix],
        [hexFILString],
      );
    }
  });

  describe('Init Collateral with 100,000 Wei for Bob', async () => {
    it('Register collateral book with 100,000 Wei payment', async () => {
      let result = await collateralAggregator.register({
        from: bob,
        value: 100000,
      });
      expectEvent(result, 'Register');
    });
  });

  describe('deploy Lending Markets for each term of FIL market', async () => {
    it('deploy Lending Markets for each term for FIL market', async () => {
      for (let i = 0; i < termDays.length; i++) {
        const tx = await lendingMarketController.deployLendingMarket(
          hexFILString,
          termDays[i],
        );
        const receipt = await tx.wait();
        const { marketAddr } = receipt.events.find(
          ({ event }) => event === 'LendingMarketCreated',
        ).args;

        lendingMarkets.push(marketAddr);
        let lendingMarket = await LendingMarket.at(marketAddr);

        await collateralAggregator.addCollateralUser(lendingMarket.address, {
          from: owner,
        });
        await loan.addLendingMarket(
          hexFILString,
          termDays[i],
          lendingMarket.address,
        );
      }

      let terms = await lendingMarketController.getSupportedTerms(hexFILString);
      terms.map((term, i) => {
        term.toString().should.be.equal(sortedTermDays[i].toString());
      });
    });

    it('Expect revert on adding new 3m FIL market', async () => {
      await expectRevert(
        lendingMarketController.deployLendingMarket(hexFILString, termDays[0]),
        "Couldn't rewrite existing market",
      );
    });

    it('initiate lend orders for each market', async () => {
      for (i = 0; i < lendingMarkets.length; i++) {
        let lendingMarket = await LendingMarket.at(lendingMarkets[i]);
        amount = orderList[i]['amount'];
        orderId = orderList[i]['orderId'];
        rate = orderList[i]['rate'];

        let marketOrder = await lendingMarket.order(0, amount, rate, {
          from: bob,
        });
        expectEvent(marketOrder, 'MakeOrder');
      }
    });

    it('initiate borrow orders for each market', async () => {
      for (i = 0; i < lendingMarkets.length; i++) {
        let lendingMarket = await LendingMarket.at(lendingMarkets[i]);
        amount = orderList[i]['amount'];
        orderId = orderList[i]['orderId'];
        rate = orderList[i]['rate'];

        let marketOrder = await lendingMarket.order(1, amount, rate + 25, {
          from: bob,
        });
        expectEvent(marketOrder, 'MakeOrder');
      }
    });

    it('get lend rate for each market', async () => {
      for (i = 0; i < lendingMarkets.length; i++) {
        let lendingMarket = await LendingMarket.at(lendingMarkets[i]);
        let rate = await lendingMarket.getLendRate({ from: bob });
        rate.toNumber().should.be.equal(800);
      }
    });

    it('get borrow rate for each market', async () => {
      for (i = 0; i < lendingMarkets.length; i++) {
        let lendingMarket = await LendingMarket.at(lendingMarkets[i]);
        let rate = await lendingMarket.getBorrowRate({ from: bob });
        rate.toNumber().should.be.equal(825);
      }
    });

    it('get mid rate for each market', async () => {
      for (i = 0; i < lendingMarkets.length; i++) {
        let lendingMarket = await LendingMarket.at(lendingMarkets[i]);
        let rate = await lendingMarket.getMidRate({ from: bob });
        rate.toNumber().should.be.equal(812);
      }
    });

    it('get lend rates from lending controller for FIL', async () => {
      let rate = await lendingMarketController.getLendRatesForCcy(hexFILString);
      rate[0].toNumber().should.be.equal(800);
      rate[1].toNumber().should.be.equal(800);
      rate[2].toNumber().should.be.equal(800);
      rate[3].toNumber().should.be.equal(800);
      rate[4].toNumber().should.be.equal(800);
      rate[5].toNumber().should.be.equal(800);
    });

    it('get borrow rates from lending controller for FIL', async () => {
      let rate = await lendingMarketController.getBorrowRatesForCcy(
        hexFILString,
      );
      rate[0].toNumber().should.be.equal(825);
      rate[1].toNumber().should.be.equal(825);
      rate[2].toNumber().should.be.equal(825);
      rate[3].toNumber().should.be.equal(825);
      rate[4].toNumber().should.be.equal(825);
      rate[5].toNumber().should.be.equal(825);
    });

    it('get mid rates from lending controller for FIL', async () => {
      let rate = await lendingMarketController.getMidRatesForCcy(hexFILString);
      rate[0].toNumber().should.be.equal(812);
      rate[1].toNumber().should.be.equal(812);
      rate[2].toNumber().should.be.equal(812);
      rate[3].toNumber().should.be.equal(812);
      rate[4].toNumber().should.be.equal(812);
      rate[5].toNumber().should.be.equal(812);
    });

    it('get discount factors from lending controller for FIL', async () => {
      let rate = await lendingMarketController.getDiscountFactorsForCcy(
        hexFILString,
      );
      console.log('df3m: ' + rate[0][0]);
      console.log('df6m: ' + rate[0][1]);
      console.log('df1y: ' + rate[0][2]);
      console.log('df2y: ' + rate[0][3]);
      console.log('df3y: ' + rate[0][4]);
      console.log('df4y: ' + rate[0][5]);
      console.log('df5y: ' + rate[0][6]);
    });
  });
});
