import { Contract } from 'ethers';
import { ethers } from 'hardhat';
import moment from 'moment';

import { currencies, mockPriceFeeds } from '../../utils/currencies';
import {
  hexEFIL,
  hexETH,
  hexUSDC,
  hexWBTC,
  hexWFIL,
  toBytes32,
} from '../../utils/strings';
import {
  AUTO_ROLL_FEE_RATE,
  INITIAL_COMPOUND_FACTOR,
  LIQUIDATION_PROTOCOL_FEE_RATE,
  LIQUIDATION_THRESHOLD_RATE,
  LIQUIDATOR_FEE_RATE,
  MARKET_BASE_PERIOD,
  MARKET_OBSERVATION_PERIOD,
  ORDER_FEE_RATE,
} from './constants';

const deployContracts = async () => {
  // Deploy libraries
  const [
    depositManagementLogic,
    lendingMarketOperationLogic,
    orderBookLogic,
    quickSort,
  ] = await Promise.all(
    [
      'DepositManagementLogic',
      'LendingMarketOperationLogic',
      'OrderBookLogic',
      'QuickSort',
    ].map((library) =>
      ethers.getContractFactory(library).then((factory) => factory.deploy()),
    ),
  );
  const fundManagementLogic = await ethers
    .getContractFactory('FundManagementLogic', {
      libraries: {
        QuickSort: quickSort.address,
      },
    })
    .then((factory) => factory.deploy());

  // Deploy contracts
  const [
    addressResolver,
    beaconProxyController,
    currencyController,
    genesisValueVault,
    wETHToken,
    reserveFund,
    tokenVault,
    lendingMarketController,
  ] = await Promise.all([
    ...[
      'AddressResolver',
      'BeaconProxyController',
      'CurrencyController',
      'GenesisValueVault',
      'MockWETH9',
      'ReserveFund',
    ].map((contract) =>
      ethers.getContractFactory(contract).then((factory) => factory.deploy()),
    ),
    ethers
      .getContractFactory('TokenVault', {
        libraries: {
          DepositManagementLogic: depositManagementLogic.address,
        },
      })
      .then((factory) => factory.deploy()),
    ethers
      .getContractFactory('LendingMarketController', {
        libraries: {
          FundManagementLogic: fundManagementLogic.address,
          LendingMarketOperationLogic: lendingMarketOperationLogic.address,
        },
      })
      .then((factory) => factory.deploy()),
  ]);

  const wFILToken = await ethers
    .getContractFactory('MockWFIL')
    .then((factory) => factory.deploy('10000000000000000000000000000'));
  const eFILToken = await ethers
    .getContractFactory('MockEFIL')
    .then((factory) => factory.deploy('10000000000000000000000000000'));
  const usdcToken = await ethers
    .getContractFactory('MockUSDC')
    .then((factory) => factory.deploy('100000000000000000'));
  const wBTCToken = await ethers
    .getContractFactory('MockWBTC')
    .then((factory) => factory.deploy('100000000000000000'));

  const proxyController = await ethers
    .getContractFactory('ProxyController')
    .then((factory) => factory.deploy(ethers.constants.AddressZero));

  // Get the Proxy contract address of AddressResolver
  await proxyController.setAddressResolverImpl(addressResolver.address);
  const addressResolverProxyAddress =
    await proxyController.getAddressResolverAddress();

  // Deploy MigrationAddressResolver
  const migrationAddressResolver = await ethers
    .getContractFactory('MigrationAddressResolver')
    .then((factory) => factory.deploy());

  // Set contract addresses to the Proxy contract
  const [
    beaconProxyControllerAddress,
    currencyControllerAddress,
    genesisValueVaultAddress,
    lendingMarketControllerAddress,
    reserveFundAddress,
    tokenVaultAddress,
  ] = await Promise.all([
    proxyController.setBeaconProxyControllerImpl(beaconProxyController.address),
    proxyController.setCurrencyControllerImpl(
      currencyController.address,
      hexETH,
    ),
    proxyController.setGenesisValueVaultImpl(genesisValueVault.address),
    proxyController.setLendingMarketControllerImpl(
      lendingMarketController.address,
      MARKET_BASE_PERIOD,
      MARKET_OBSERVATION_PERIOD,
    ),
    proxyController.setReserveFundImpl(reserveFund.address, wETHToken.address),
    proxyController.setTokenVaultImpl(
      tokenVault.address,
      LIQUIDATION_THRESHOLD_RATE,
      LIQUIDATION_PROTOCOL_FEE_RATE,
      LIQUIDATOR_FEE_RATE,
      wETHToken.address,
    ),
  ])
    .then((txs) => Promise.all(txs.map((tx) => tx.wait())))
    .then((txs) =>
      txs.map(
        ({ events }) =>
          events.find(({ event }) => event === 'ProxyCreated').args
            .proxyAddress,
      ),
    );

  // Get the Proxy contract addresses
  const addressResolverProxy = await ethers.getContractAt(
    'AddressResolver',
    addressResolverProxyAddress,
  );
  const beaconProxyControllerProxy = await ethers.getContractAt(
    'BeaconProxyController',
    beaconProxyControllerAddress,
  );
  const currencyControllerProxy = await ethers.getContractAt(
    'CurrencyController',
    currencyControllerAddress,
  );
  const genesisValueVaultProxy = await ethers.getContractAt(
    'GenesisValueVault',
    genesisValueVaultAddress,
  );
  const lendingMarketControllerProxy = await ethers.getContractAt(
    'LendingMarketController',
    lendingMarketControllerAddress,
  );
  const reserveFundProxy = await ethers.getContractAt(
    'ReserveFund',
    reserveFundAddress,
  );
  const tokenVaultProxy = await ethers.getContractAt(
    'TokenVault',
    tokenVaultAddress,
  );

  // Set up for CurrencyController
  const priceFeeds: Record<string, Contract> = {};
  const MockV3Aggregator = await ethers.getContractFactory('MockV3Aggregator');

  for (const currency of currencies) {
    const priceFeedAddresses: string[] = [];

    if (mockPriceFeeds[currency.key]) {
      for (const priceFeed of mockPriceFeeds[currency.key]) {
        priceFeeds[currency.key] = await MockV3Aggregator.deploy(
          priceFeed.decimals,
          currency.key,
          priceFeed.rate,
        );
        priceFeedAddresses.push(priceFeeds[currency.key].address);
      }
    }

    await currencyControllerProxy.addCurrency(
      currency.key,
      currency.haircut,
      priceFeedAddresses,
    );
  }

  // Set up for AddressResolver and build caches using MigrationAddressResolver
  const migrationTargets: [string, Contract][] = [
    ['BeaconProxyController', beaconProxyControllerProxy],
    ['CurrencyController', currencyControllerProxy],
    ['GenesisValueVault', genesisValueVaultProxy],
    ['LendingMarketController', lendingMarketControllerProxy],
    ['ReserveFund', reserveFundProxy],
    ['TokenVault', tokenVaultProxy],
  ];

  const importAddressesArgs = {
    names: migrationTargets.map(([name]) => toBytes32(name)),
    addresses: migrationTargets.map(([, contract]) => contract.address),
  };

  const buildCachesAddresses = [
    beaconProxyControllerProxy,
    lendingMarketControllerProxy,
    genesisValueVaultProxy,
    reserveFundProxy,
    tokenVaultProxy,
  ]
    .filter((contract) => !!contract.buildCache) // exclude contracts that doesn't have buildCache method such as mock
    .map((contract) => contract.address);

  await addressResolverProxy.importAddresses(
    importAddressesArgs.names,
    importAddressesArgs.addresses,
  );
  await migrationAddressResolver.buildCaches(buildCachesAddresses);

  // Set up for LendingMarketController
  const lendingMarket = await ethers
    .getContractFactory('LendingMarket', {
      libraries: {
        OrderBookLogic: orderBookLogic.address,
      },
    })
    .then((factory) => factory.deploy());
  const futureValueVault = await ethers
    .getContractFactory('FutureValueVault')
    .then((factory) => factory.deploy());

  await beaconProxyControllerProxy.setLendingMarketImpl(lendingMarket.address);
  await beaconProxyControllerProxy.setFutureValueVaultImpl(
    futureValueVault.address,
  );

  const { timestamp } = await ethers.provider.getBlock('latest');
  const genesisDate = moment(timestamp * 1000).unix();
  await Promise.all([
    lendingMarketControllerProxy.initializeLendingMarket(
      hexWBTC,
      genesisDate,
      INITIAL_COMPOUND_FACTOR,
      ORDER_FEE_RATE,
      AUTO_ROLL_FEE_RATE,
    ),
    lendingMarketControllerProxy.initializeLendingMarket(
      hexETH,
      genesisDate,
      INITIAL_COMPOUND_FACTOR,
      ORDER_FEE_RATE,
      AUTO_ROLL_FEE_RATE,
    ),
    lendingMarketControllerProxy.initializeLendingMarket(
      hexWFIL,
      genesisDate,
      INITIAL_COMPOUND_FACTOR,
      ORDER_FEE_RATE,
      AUTO_ROLL_FEE_RATE,
    ),
    lendingMarketControllerProxy.initializeLendingMarket(
      hexEFIL,
      genesisDate,
      INITIAL_COMPOUND_FACTOR,
      ORDER_FEE_RATE,
      AUTO_ROLL_FEE_RATE,
    ),
    lendingMarketControllerProxy.initializeLendingMarket(
      hexUSDC,
      genesisDate,
      INITIAL_COMPOUND_FACTOR,
      ORDER_FEE_RATE,
      AUTO_ROLL_FEE_RATE,
    ),
  ]);

  return {
    genesisDate,
    fundManagementLogic,
    // contracts
    addressResolver: addressResolverProxy,
    beaconProxyController: beaconProxyControllerProxy,
    tokenVault: tokenVaultProxy,
    currencyController: currencyControllerProxy,
    genesisValueVault: genesisValueVaultProxy,
    lendingMarketController: lendingMarketControllerProxy,
    proxyController,
    reserveFund: reserveFundProxy,
    wFILToken,
    eFILToken,
    wETHToken,
    wBTCToken,
    usdcToken,
    wFilToETHPriceFeed: priceFeeds[hexWFIL],
    eFilToETHPriceFeed: priceFeeds[hexEFIL],
    wBtcToETHPriceFeed: priceFeeds[hexWBTC],
    usdcToUSDPriceFeed: priceFeeds[hexUSDC],
  };
};

export { deployContracts };
