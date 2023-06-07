import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { MockContract } from 'ethereum-waffle';
import { Contract } from 'ethers';
import { artifacts, ethers, waffle } from 'hardhat';
import { hexETH } from '../../utils/strings';

const AddressResolver = artifacts.require('AddressResolver');
const CurrencyController = artifacts.require('CurrencyController');
const MockV3Aggregator = artifacts.require('MockV3Aggregator');
const ProxyController = artifacts.require('ProxyController');

const { deployContract, deployMockContract } = waffle;

describe('CurrencyController', () => {
  let currencyControllerProxy: Contract;
  let mockPriceFeed: MockContract;

  let owner: SignerWithAddress;

  let testIdx = 0;

  before(async () => {
    [owner] = await ethers.getSigners();

    // Set up for the mocks
    mockPriceFeed = await deployMockContract(owner, MockV3Aggregator.abi);

    // Deploy
    const addressResolver = await deployContract(owner, AddressResolver);
    const proxyController = await deployContract(owner, ProxyController, [
      ethers.constants.AddressZero,
    ]);
    const currencyController = await deployContract(owner, CurrencyController);

    // Get the Proxy contract addresses
    await proxyController.setAddressResolverImpl(addressResolver.address);

    const currencyControllerAddress = await proxyController
      .setCurrencyControllerImpl(currencyController.address, hexETH)
      .then((tx) => tx.wait())
      .then(
        ({ events }) =>
          events.find(({ event }) => event === 'ProxyCreated').args
            .proxyAddress,
      );

    currencyControllerProxy = await ethers.getContractAt(
      'CurrencyController',
      currencyControllerAddress,
    );
  });

  describe('Initialize', async () => {
    it('Add ETH as a supported currency', async () => {
      const currency = ethers.utils.formatBytes32String('ETH');

      // Set up for the mocks
      await mockPriceFeed.mock.latestRoundData.returns(0, 100, 0, 0, 0);
      await mockPriceFeed.mock.decimals.returns(18);

      const tx = await currencyControllerProxy.addCurrency(
        currency,
        18,
        9000,
        [],
      );
      await expect(tx).to.emit(currencyControllerProxy, 'CurrencyAdded');
      await expect(tx).to.not.emit(currencyControllerProxy, 'PriceFeedUpdated');

      await currencyControllerProxy.currencyExists(currency).then((exists) => {
        expect(exists).to.true;
      });

      await currencyControllerProxy
        .currencyExists(ethers.utils.formatBytes32String('TEST'))
        .then((exists) => expect(exists).to.equal(false));

      await currencyControllerProxy
        .getDecimals(currency)
        .then((decimals) => expect(decimals).to.equal(0));

      await currencyControllerProxy
        .getBaseCurrency()
        .then((baseCurrency) => expect(baseCurrency).to.equal(hexETH));

      await currencyControllerProxy
        .getHaircut(currency)
        .then((haircut) => expect(haircut).to.equal(9000));
    });

    it('Add a currency except for ETH as a supported currency', async () => {
      const currency = ethers.utils.formatBytes32String('EFIL');

      // Set up for the mocks
      await mockPriceFeed.mock.latestRoundData.returns(0, 100, 0, 0, 0);
      await mockPriceFeed.mock.decimals.returns(18);

      const tx = await currencyControllerProxy.addCurrency(currency, 18, 9000, [
        mockPriceFeed.address,
      ]);
      await expect(tx).to.emit(currencyControllerProxy, 'CurrencyAdded');
      await expect(tx).to.emit(currencyControllerProxy, 'PriceFeedUpdated');

      await currencyControllerProxy
        .getDecimals(currency)
        .then((decimals) => expect(decimals).to.equal(18));
    });

    it('Fail to add ETH as a supported currency due to the invalid price feed', async () => {
      const currency = ethers.utils.formatBytes32String('ETH');

      // Set up for the mocks
      await mockPriceFeed.mock.latestRoundData.returns(0, -1, 0, 0, 0);
      await mockPriceFeed.mock.decimals.returns(18);

      await expect(
        currencyControllerProxy.addCurrency(currency, 18, 8000, [
          mockPriceFeed.address,
        ]),
      ).to.be.revertedWith('Invalid PriceFeed');
    });

    it('Fail to add ETH as a supported currency due to the invalid decimals', async () => {
      const currency = ethers.utils.formatBytes32String('ETH');

      // Set up for the mocks
      await mockPriceFeed.mock.latestRoundData.returns(0, 100, 0, 0, 0);
      await mockPriceFeed.mock.decimals.returns(19);

      await expect(
        currencyControllerProxy.addCurrency(currency, 18, 8000, [
          mockPriceFeed.address,
        ]),
      ).to.be.revertedWith('Invalid decimals');
    });
  });

  describe('Update', async () => {
    let currency: string;

    beforeEach(async () => {
      currency = ethers.utils.formatBytes32String(`Test${testIdx}`);
      testIdx++;

      // Set up for the mocks
      await mockPriceFeed.mock.latestRoundData.returns(0, 100, 0, 0, 0);
      await mockPriceFeed.mock.decimals.returns(18);

      await currencyControllerProxy.addCurrency(currency, 18, 9000, [
        mockPriceFeed.address,
      ]);
    });

    it('Update a currency support', async () => {
      await expect(currencyControllerProxy.removeCurrency(currency))
        .to.emit(currencyControllerProxy, 'CurrencyRemoved')
        .withArgs(currency);

      expect(await currencyControllerProxy.currencyExists(currency)).to.false;
    });

    it('Update a haircut', async () => {
      await expect(currencyControllerProxy.updateHaircut(currency, 10))
        .to.emit(currencyControllerProxy, 'HaircutUpdated')
        .withArgs(currency, 10);

      expect(await currencyControllerProxy.getHaircut(currency)).to.equal(10);
    });

    it('Update a price feed', async () => {
      // Set up for the mocks
      const newMockPriceFeed = await deployMockContract(
        owner,
        MockV3Aggregator.abi,
      );
      await newMockPriceFeed.mock.latestRoundData.returns(0, 200, 0, 0, 0);
      await newMockPriceFeed.mock.getRoundData.returns(0, 300, 0, 1000, 0);
      await newMockPriceFeed.mock.decimals.returns(18);

      await expect(
        currencyControllerProxy.updatePriceFeed(currency, 18, [
          newMockPriceFeed.address,
        ]),
      ).to.emit(currencyControllerProxy, 'PriceFeedUpdated');

      expect(await currencyControllerProxy.getLastPrice(currency)).to.equal(
        200,
      );
    });

    it('Update multiple price feeds', async () => {
      // Set up for the mocks
      const newMockPriceFeed1 = await deployMockContract(
        owner,
        MockV3Aggregator.abi,
      );
      const newMockPriceFeed2 = await deployMockContract(
        owner,
        MockV3Aggregator.abi,
      );
      await newMockPriceFeed1.mock.latestRoundData.returns(0, 200, 0, 0, 0);
      await newMockPriceFeed1.mock.getRoundData.returns(0, 200, 0, 2000, 0);
      await newMockPriceFeed1.mock.decimals.returns(6);
      await newMockPriceFeed2.mock.latestRoundData.returns(0, 400, 0, 0, 0);
      await newMockPriceFeed2.mock.getRoundData.returns(0, 500, 0, 1000, 0);
      await newMockPriceFeed2.mock.decimals.returns(18);

      await expect(
        currencyControllerProxy.updatePriceFeed(currency, 18, [
          newMockPriceFeed1.address,
          newMockPriceFeed2.address,
        ]),
      ).to.emit(currencyControllerProxy, 'PriceFeedUpdated');

      expect(await currencyControllerProxy.getDecimals(currency)).to.equal(24);
      expect(await currencyControllerProxy.getLastPrice(currency)).to.equal(
        80000,
      );
    });

    it('Remove a  price feed', async () => {
      // Set up for the mocks
      const newMockPriceFeed = await deployMockContract(
        owner,
        MockV3Aggregator.abi,
      );
      await newMockPriceFeed.mock.latestRoundData.returns(0, 200, 0, 0, 0);
      await newMockPriceFeed.mock.getRoundData.returns(0, 300, 0, 1000, 0);
      await newMockPriceFeed.mock.decimals.returns(18);

      await expect(
        currencyControllerProxy.updatePriceFeed(currency, 18, [
          newMockPriceFeed.address,
        ]),
      ).to.emit(currencyControllerProxy, 'PriceFeedUpdated');

      await expect(currencyControllerProxy.removePriceFeed(currency))
        .to.emit(currencyControllerProxy, 'PriceFeedRemoved')
        .withArgs(currency);
    });

    it('Fail to update a haircut due to overflow', async () => {
      await expect(
        currencyControllerProxy.updateHaircut(currency, 10001),
      ).to.be.revertedWith('Haircut ratio overflow');
    });

    it('Fail to remove a price feed due to invalid PriceFeed', async () => {
      const dummyCurrency = ethers.utils.formatBytes32String('Dummy1');

      // Set up for the mocks
      await mockPriceFeed.mock.latestRoundData.returns(0, 100, 0, 0, 0);
      await mockPriceFeed.mock.decimals.returns(18);

      await currencyControllerProxy.addCurrency(dummyCurrency, 18, 9000, []);

      await expect(
        currencyControllerProxy.removePriceFeed(dummyCurrency),
      ).to.be.revertedWith('Invalid PriceFeed');
    });
  });

  describe('Convert', async () => {
    let currency: string;

    beforeEach(async () => {
      currency = ethers.utils.formatBytes32String(`Test${testIdx}`);
      testIdx++;

      // Set up for the mocks
      await mockPriceFeed.mock.latestRoundData.returns(0, 10000000000, 0, 0, 0);
      await mockPriceFeed.mock.decimals.returns(18);

      await currencyControllerProxy.addCurrency(currency, 18, 9000, [
        mockPriceFeed.address,
      ]);
    });

    it('Get the converted amount(int256) in ETH', async () => {
      const amount = await currencyControllerProxy[
        'convertToBaseCurrency(bytes32,int256)'
      ](currency, 10000000000);

      expect(amount).to.equal('100');
    });

    it('Get the converted amount(uint256) in ETH', async () => {
      const amount = await currencyControllerProxy[
        'convertToBaseCurrency(bytes32,uint256)'
      ](currency, 10000000000);

      expect(amount).to.equal('100');
    });

    it('Get the array of converted amount(uint256[]) in ETH', async () => {
      const amounts = await currencyControllerProxy[
        'convertToBaseCurrency(bytes32,uint256[])'
      ](currency, [10000000000]);

      expect(amounts.length).to.equal(1);
      expect(amounts[0]).to.equal('100');
    });

    it('Get the converted amount(uint256) in the selected currency', async () => {
      const amount = await currencyControllerProxy.convertFromBaseCurrency(
        currency,
        10000000000,
      );

      expect(amount).to.equal('1000000000000000000');
    });
  });
});
