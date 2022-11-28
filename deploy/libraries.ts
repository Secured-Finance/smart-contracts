import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { executeIfNewlyDeployment } from '../utils/deployment';

const func: DeployFunction = async function ({
  getNamedAccounts,
  deployments,
}: HardhatRuntimeEnvironment) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('OrderBookLogic', {
    from: deployer,
  }).then((result) => executeIfNewlyDeployment('OrderBookLogic', result));
};

func.tags = ['Libraries'];

export default func;
