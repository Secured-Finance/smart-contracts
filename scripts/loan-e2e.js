const { ethers, deployments, run } = require('hardhat');
const {
  toBytes32,
  hexETHString,
  hexFILString,
  loanPrefix,
  aliceFILAddress,
  bobFILAddress,
} = require('../test-utils').strings;

const { expect } = require('chai');
const moment = require('moment');

contract('Loan E2E Test', async () => {
  const targetCurrency = hexFILString;
  const BP = 0.01;
  const depositAmountInETH = '10000000000000000000';
  const orderAmountInFIL = '50000000000000000000';
  const orderRate = String(3 / BP);
  const txHashSample = 'txHashSample';

  // Accounts
  let ownerSigner;
  let aliceSigner;
  let bobSigner;
  let carolSigner;

  // Contracts
  let proxyController;
  let chainlinkSettlementAdapter;
  let operator;

  // Proxy Contracts
  let collateralAggregator;
  let collateralVault;
  let lendingMarketController;

  let loanId;

  before('Set up for testing', async () => {
    const blockNumber = await ethers.provider.getBlockNumber();
    const network = await ethers.provider.getNetwork();

    console.log('Block number is', blockNumber);
    console.log('Chain id is', network.chainId);

    [ownerSigner, aliceSigner, bobSigner, carolSigner] =
      await ethers.getSigners();

    if (process.env.FORK_RPC_ENDPOINT) {
      ownerSigner = new ethers.Wallet(process.env.PRIVATE_KEY, ethers.provider);
    }

    console.table(
      {
        owner: ownerSigner,
        alice: aliceSigner,
        bob: bobSigner,
        carol: carolSigner,
      },
      ['address'],
    );

    // Get ETH
    if (process.env.FORK_RPC_ENDPOINT) {
      const params = [[ownerSigner.address], ethers.utils.hexValue(10)];
      await ethers.provider.send('tenderly_addBalance', params);
    }

    const getProxy = (key, contract) =>
      proxyController
        .getAddress(toBytes32(key))
        .then((address) => ethers.getContractAt(contract || key, address));

    // Get contracts
    proxyController = await deployments
      .get('ProxyController')
      .then(({ address }) => ethers.getContractAt('ProxyController', address));

    chainlinkSettlementAdapter = await deployments
      .get('ChainlinkSettlementAdapter')
      .then(({ address }) =>
        ethers.getContractAt('ChainlinkSettlementAdapter', address),
      );

    operator = await deployments
      .get('Operator')
      .then(({ address }) => ethers.getContractAt('Operator', address));

    console.table(
      {
        proxyController,
        chainlinkSettlementAdapter,
        operator,
      },
      ['address'],
    );

    // Get proxy contracts
    collateralAggregator = await getProxy('CollateralAggregator');
    collateralVault = await getProxy('CollateralVault');
    lendingMarketController = await getProxy('LendingMarketController');

    console.table(
      {
        collateralAggregator,
        collateralVault,
        lendingMarketController,
      },
      ['address'],
    );
  });

  it('Deposit ETH', async () => {
    // Deposit ETH by Alice
    const isRegisteredAlice = await collateralAggregator.checkRegisteredUser(
      aliceSigner.address,
    );

    if (!isRegisteredAlice) {
      await collateralAggregator
        .connect(aliceSigner)
        ['register(string[],uint256[])']([aliceFILAddress], [461]);
      await collateralVault
        .connect(aliceSigner)
        ['deposit(bytes32,uint256)'](hexETHString, depositAmountInETH, {
          value: depositAmountInETH,
        });
    }

    // Deposit ETH by BoB
    const isRegisteredBob = await collateralAggregator.checkRegisteredUser(
      bobSigner.address,
    );

    if (!isRegisteredBob) {
      await collateralAggregator
        .connect(bobSigner)
        ['register(string[],uint256[])']([bobFILAddress], [461]);

      await collateralVault
        .connect(bobSigner)
        ['deposit(bytes32,uint256)'](hexETHString, depositAmountInETH, {
          value: depositAmountInETH,
        });
    }

    // Check collateral of Alice
    let independentCollateral = await collateralVault.getIndependentCollateral(
      aliceSigner.address,
      hexETHString,
    );

    let lockedCollateral = await collateralVault[
      'getLockedCollateral(address,bytes32)'
    ](aliceSigner.address, hexETHString);

    expect(independentCollateral.toString()).to.equal(depositAmountInETH);
    expect(lockedCollateral.toString()).to.equal('0');
  });

  it('Take order', async () => {
    // Get FIL markets
    // const market3m = await lendingMarketController
    //   .getLendingMarket(targetCurrency, terms[0])
    //   .then((address) => ethers.getContractAt('LendingMarket', address));

    // // Make lend orders
    // await market3m.connect(aliceSigner).order(0, orderAmountInFIL, orderRate);

    // Make borrow orders
    const receipt = await market3m
      .connect(bobSigner)
      .order(1, orderAmountInFIL, orderRate)
      .then((tx) => tx.wait());

    const { dealId } = await loan
      .queryFilter(loan.filters.Register(), receipt.blockHash)
      .then(
        (events) =>
          events.find(
            ({ transactionHash }) =>
              transactionHash === receipt.transactionHash,
          ).args,
      );
    loanId = dealId;

    // Check loan deal
    const deal = await loan.getLoanDeal(loanId);

    expect(deal.lender).to.equal(aliceSigner.address);
    expect(deal.borrower).to.equal(bobSigner.address);
    expect(deal.ccy).to.equal(hexFILString);
    // expect(deal.term.toString()).to.equal('90');
    expect(deal.notional.toString()).to.equal(orderAmountInFIL);
    expect(deal.rate.toString()).to.equal(orderRate);

    // Check collateral of Bob
    const independentCollateralAlice =
      await collateralVault.getIndependentCollateral(
        aliceSigner.address,
        hexETHString,
      );
    const independentCollateralBob =
      await collateralVault.getIndependentCollateral(
        bobSigner.address,
        hexETHString,
      );

    const lockedCollaterals = await collateralVault[
      'getLockedCollateral(address,address,bytes32)'
    ](aliceSigner.address, bobSigner.address, hexETHString);

    expect(
      independentCollateralAlice.add(lockedCollaterals[0]).toString(),
    ).to.equal(depositAmountInETH);
    expect(
      independentCollateralBob.add(lockedCollaterals[1]).toString(),
    ).to.equal(depositAmountInETH);
  });
});
