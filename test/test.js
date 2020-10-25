const {accounts, contract} = require('@openzeppelin/test-environment');
const {expect} = require('chai');
const {
  BN,
  expectEvent,
  expectRevert,
  constants,
  time,
} = require('@openzeppelin/test-helpers');
const MoneyMarket = contract.fromArtifact('MoneyMarket');
const FXMarket = contract.fromArtifact('FXMarket');
const Collateral = contract.fromArtifact('Collateral');
const Loan = contract.fromArtifact('Loan');
const {Side, Ccy, Term, sample} = require('./constants');
const {toDate, printDate, printNum, printCol, printLoan} = require('./helper');

describe('MoneyMarket', () => {
  console.log('accounts is', accounts);
  const [owner] = accounts;
  let moneyMarket;
  let fxMarket;
  let collateral;
  let loan;
  before(async () => {
    // beforeEach(async () => {
    moneyMarket = await MoneyMarket.new({from: owner});
    fxMarket = await FXMarket.new({from: owner});
    collateral = await Collateral.new(moneyMarket.address, fxMarket.address, {
      from: owner,
    });
    loan = await Loan.new(
      moneyMarket.address,
      fxMarket.address,
      collateral.address,
    );
    console.log();
    console.log('moneyMarket addr is', moneyMarket.address);
    console.log('fxMarket    addr is', fxMarket.address);
    console.log('collateral  addr is', collateral.address);
    console.log('loan        addr is', loan.address);
    console.log('\n');
  });

  it('Init MoneyMarket with sample data', async () => {
    let input = sample.MoneyMarket[1];
    let res = await moneyMarket.setMoneyMarketBook(
      input.ccy,
      input.lenders,
      input.borrowers,
      input.effectiveSec,
      {from: owner},
    );
    expectEvent(res, 'SetMoneyMarketBook', {sender: accounts[0]});
  });

  it('Init FXMarket with sample data', async () => {
    let input = sample.FXMarket[0];
    let res = await fxMarket.setFXBook(
      input.pair,
      input.offerInput,
      input.bidInput,
      input.effectiveSec,
      {from: owner},
    );
    expectEvent(res, 'SetFXBook', {sender: accounts[0]});
  });

  it('Get item from moneyMarketBook', async () => {
    // const books = await this.moneyMarket.getAllBooks();
    // console.log('books is', books[0]);

    // const midRates = await this.moneyMarket.getMidRates();
    // console.log('midRates is', midRates);

    // const df = await this.moneyMarket.getDiscountFactors();
    // console.log('df is', df);

    // const book = await this.moneyMarket.getOneBook(owner);
    // console.log('book', book[0]);

    const item = await moneyMarket.getOneItem(
      owner,
      Side.BORROW,
      Ccy.FIL,
      Term._3m,
    );
    expect(item.amt).to.equal('10000');
  });

  it('Check time forward', async () => {
    // console.log('zero addr is', constants.ZERO_ADDRESS);
    let latest = await time.latest();
    // console.log('latest is', latest.toString(), toDate(latest));

    // let latestBlock = await time.latestBlock();
    // console.log('latestBlock is', latestBlock.toString());

    await time.increase(100);
    let latest2 = await time.latest();
    // console.log('latest2 is', latest2.toString(), toDate(latest2));

    expect(latest2 - latest).to.equal(100);

    // await time.increase(time.duration.years(1) / 12 - time.duration.weeks(2));
    // let latest3 = await time.latest();
    // // console.log('latest3 is', latest3.toString());
    // console.log('latest3 is', latest3.toString(), toDate(latest3));

    // let latestBlock2 = await time.latestBlock();
    // console.log('latestBlock2 is', latestBlock2.toString());
  });

  it('Init Collateral with sample data', async () => {
    input = sample.Collateral;
    let res;
    res = await collateral.setColBook(input[0].id, input[0].addrFIL, {
      from: accounts[0],
      value: 10000,
    });
    expectEvent(res, 'SetColBook', {sender: accounts[0]});
    res = await collateral.setColBook(input[1].id, input[1].addrFIL, {
      from: accounts[1],
      value: 10000,
    });
    expectEvent(res, 'SetColBook', {sender: accounts[1]});
    res = await collateral.setColBook(input[2].id, input[2].addrFIL, {
      from: accounts[2],
    });
    expectEvent(res, 'SetColBook', {sender: accounts[2]});

    res = await collateral.registerFILCustodyAddr(
      'cid_custody_FIL_0',
      accounts[0],
    );
    expectEvent(res, 'RegisterFILCustodyAddr', {requester: accounts[0]});
    res = await collateral.registerFILCustodyAddr(
      'cid_custody_FIL_1',
      accounts[1],
    );
    expectEvent(res, 'RegisterFILCustodyAddr', {requester: accounts[1]});
    res = await collateral.registerFILCustodyAddr(
      'cid_custody_FIL_2',
      accounts[2],
    );
    expectEvent(res, 'RegisterFILCustodyAddr', {requester: accounts[2]});
  });

  it('Collateralize', async () => {
    await printCol(collateral, accounts[2], 'Registered');
    let res = await collateral.upSizeETH({
      from: accounts[2],
      value: 20000, // 20000 ETH can cover about 244000 FIL
      // value: 1000000000000000000, // 1 ETH in wei
    });
    expectEvent(res, 'UpSizeETH', {sender: accounts[2]});
    await printCol(collateral, accounts[2], 'upSizeETH (ETH 20000 added)');
  });

  let beforeLoan;
  let afterLoan;
  it('Make Loan Deal', async () => {
    input = sample.Loan;
    input.makerAddr = accounts[0];
    beforeLoan = await moneyMarket.getOneItem(
      input.makerAddr,
      input.side,
      input.ccy,
      input.term,
    );

    // console.log('input is', input)

    // Init Loan with sample data
    let taker = accounts[2];
    let res = await loan.makeLoanDeal(
      input.makerAddr,
      input.side,
      input.ccy,
      input.term,
      input.amt,
      {
        from: taker,
      },
    );
    expectEvent(res, 'MakeLoanDeal', {sender: taker});
    await printCol(
      collateral,
      accounts[2],
      'makeLoanDeal (borrow FIL 140001, FILETH is 0.082)',
    );
    await printLoan(loan, accounts[2], '');
  });

  it('Confirm FIL Payment', async () => {
    let res = await loan.confirmFILPayment(0, {
      from: accounts[2],
    });
    expectEvent(res, 'ConfirmFILPayment', {sender: accounts[2]});
    await printCol(
      collateral,
      accounts[2],
      'confirmFILPayment (coverage 174%)',
    );
    await printLoan(loan, accounts[2], '');
  });

  it('Loan Item Test', async () => {
    afterLoan = await moneyMarket.getOneItem(
      input.makerAddr,
      input.side,
      input.ccy,
      input.term,
    );
    console.log(
      'FIL loan market before',
      beforeLoan.amt,
      'FIL loan market after',
      afterLoan.amt,
    );

    // loan item test
    let book = await loan.getOneBook(accounts[2]);
    let loanItem = book.loans[0];
    printDate(loanItem.schedule.notices);
    printDate(loanItem.schedule.payments);
    console.log(loanItem.schedule.amounts);

    // discount factor test
    let df = await moneyMarket.getDiscountFactors();
    printNum(df[0]);
    printNum(df[1]);
  });
});

// // Start test block
// contract('MoneyMarket', () => {
//   beforeEach(async () => {
//     // this.moneyMarket = await MoneyMarket.new();
//     this.moneyMarket = await MoneyMarket.new();
//   });

//   it('set moneyMarketBook', async () => {
//     const input = sample.MoneyMarket;
//     await this.moneyMarket.setMoneyMarketBook(
//       input.ccy,
//       input.lenders,
//       input.borrowers,
//       input.effectiveSec,
//     );

//     // const books = await this.moneyMarket.getAllBooks();
//     // console.log('books is', books);

//     // const midRates = await this.moneyMarket.getMidRates();
//     // console.log('midRates is', midRates);

//     const item = await this.moneyMarket.getOneItem(
//       accounts[0],
//       input.side,
//       input.ccy,
//       input.term,
//     );
//     console.log('item is', item);
//   });
// });

// const sample = {
//   MoneyMarket: {
//     ccy: Ccy.FIL,
//     lenders: [
//       [0, 100, 7],
//       [1, 111, 11],
//       [2, 222, 22],
//       [3, 333, 33],
//       [4, 444, 44],
//       [5, 555, 55],
//     ],
//     borrowers: [
//       [0, 100, 5],
//       [1, 111, 6],
//       [2, 222, 20],
//       [3, 333, 30],
//       [4, 444, 40],
//       [5, 555, 50],
//     ],
//     effectiveSec: 36000,
//   },
//   FXMarket: {
//     pair: 0,
//     offerInput: [1, 0, 100000, 8500],
//     bidInput: [1, 0, 100000, 8000],
//     effectiveSec: 3600,
//   },
// };

// // helper to convert timestamp to human readable date
// const toDate = (timestamp) => {
//   const dateObject = new Date(timestamp * 1000);
//   return dateObject.toLocaleString();
// };