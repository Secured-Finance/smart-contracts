import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { executeIfNewlyDeployment } from '../utils/deployment';

const func: DeployFunction = async function ({
  getNamedAccounts,
  deployments,
  ethers,
}: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const nativeToken =
    process.env.NATIVE_TOKEN_ADDRESS ||
    (await deployments.get('MockWETH9')).address;
  const deployResult = await deploy('ReserveFund', {
    from: deployer,
  });

  await executeIfNewlyDeployment('ReserveFund', deployResult, async () => {
    const proxyController = await deployments
      .get('ProxyController')
      .then(({ address }) => ethers.getContractAt('ProxyController', address));

    await proxyController
      .setReserveFundImpl(deployResult.address, nativeToken)
      .then((tx) => tx.wait());
  });
};

func.tags = ['ReserveFund'];
func.dependencies = ['ProxyController', 'Tokens'];

export default func;
