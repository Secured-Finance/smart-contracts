const { executeIfNewlyDeployment } = require('../test-utils').deployment;

module.exports = async function ({ getNamedAccounts, deployments }) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const deployResult = await deploy('CollateralAggregator', {
    from: deployer,
  });

  await executeIfNewlyDeployment(
    'CollateralAggregator',
    deployResult,
    async () => {
      const proxyController = await deployments
        .get('ProxyController')
        .then(({ address }) =>
          ethers.getContractAt('ProxyController', address),
        );

      await proxyController
        .setCollateralAggregatorImpl(deployResult.address)
        .then((tx) => tx.wait());
    },
  );
};

module.exports.tags = ['CollateralAggregator'];
module.exports.dependencies = ['ProxyController'];
