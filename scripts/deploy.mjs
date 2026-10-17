import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from 'dotenv';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, formatEther } from 'ethers';
import { compileContract, projectRoot } from './compile.mjs';

config({ path: path.join(projectRoot, '.env'), quiet: true });
if (!process.env.PRIVATE_KEY) throw new Error('No testnet sponsor key. Run node scripts/prepare-wallet.mjs first.');
const provider = new JsonRpcProvider(process.env.RPC_URL || 'https://testnet-rpc.monad.xyz');
try {
  const network = await provider.getNetwork();
  if (network.chainId !== 10143n) throw new Error('Deployment allowed only on Monad testnet 10143. Refusing this network.');
  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const balance = await provider.getBalance(wallet.address);
  console.log('Testnet sponsor: ' + wallet.address + '; balance: ' + formatEther(balance) + ' test MON');
  if (balance === 0n) throw new Error('Test MON required. Fund the public address using https://faucet.monad.xyz then rerun.');
  const artifact = await compileContract();
  if (process.env.CONTRACT_ADDRESS) {
    const existing = new Contract(process.env.CONTRACT_ADDRESS, artifact.abi, provider);
    if ((await existing.issuer()).toLowerCase() === wallet.address.toLowerCase()) {
      console.log('Configured issuer contract already exists: ' + process.env.CONTRACT_ADDRESS + '. No duplicate deployment.');
      process.exitCode = 0;
    } else throw new Error('Configured contract issuer differs from this sponsor. Review configuration before deploying.');
  } else {
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
    const request = await factory.getDeployTransaction();
    const estimatedGas = await provider.estimateGas({ ...request, from: wallet.address });
    const gasLimit = estimatedGas * 120n / 100n;
    const fees = await provider.getFeeData();
    const price = fees.maxFeePerGas ?? fees.gasPrice;
    if (price && balance < gasLimit * price) throw new Error('Insufficient test MON for deployment gas.');
    const contract = await factory.deploy({ gasLimit });
    console.log('Deployment transaction: ' + contract.deploymentTransaction().hash);
    const receipt = await contract.deploymentTransaction().wait(2, 120000);
    if (!receipt || receipt.status !== 1) throw new Error('Deployment receipt failed.');
    const address = await contract.getAddress();
    const deployment = { chainId: 10143, network: 'monad-testnet', contractAddress: address, issuer: wallet.address,
      deploymentBlock: receipt.blockNumber, deployedAt: new Date().toISOString(), txHash: receipt.hash,
      rpcUrl: process.env.RPC_URL || 'https://testnet-rpc.monad.xyz', explorerUrl: 'https://testnet.monadscan.com', abi: artifact.abi };
    await fs.writeFile(path.join(projectRoot, 'deployment.json'), JSON.stringify(deployment, null, 2) + '\n');
    let env = await fs.readFile(path.join(projectRoot, '.env'), 'utf8');
    for (const [key, value] of Object.entries({ CONTRACT_ADDRESS: address, ISSUER_ADDRESS: wallet.address, DEPLOYMENT_BLOCK: String(receipt.blockNumber), CHAIN_ID: '10143', CHAIN_MODE: 'monad' })) {
      const expression = new RegExp('^' + key + '=.*$', 'm');
      env = expression.test(env) ? env.replace(expression, key + '=' + value) : env + '\n' + key + '=' + value + '\n';
    }
    await fs.writeFile(path.join(projectRoot, '.env'), env, { mode: 0o600 });
    console.log('Monad testnet contract deployed: ' + address);
    console.log('Explorer: https://testnet.monadscan.com/tx/' + receipt.hash);
  }
} catch (error) {
  console.error(error.shortMessage || error.message);
  process.exitCode = 1;
} finally { provider.destroy(); }
