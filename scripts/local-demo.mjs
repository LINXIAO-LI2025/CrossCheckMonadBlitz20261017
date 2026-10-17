import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config as loadEnv } from 'dotenv';
import ganache from 'ganache';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, parseEther, toBeHex } from 'ethers';
import { compileContract, projectRoot } from './compile.mjs';

loadEnv({ path: path.join(projectRoot, '.env'), quiet: true });

// This wallet is generated for the isolated local chain. Never use it on a public network.
const privateDir = path.join(projectRoot, '.local-demo');
await fs.mkdir(privateDir, { recursive: true });
let key;
try { key = JSON.parse(await fs.readFile(path.join(privateDir, 'wallet.json'), 'utf8')).privateKey; }
catch { key = Wallet.createRandom().privateKey; await fs.writeFile(path.join(privateDir, 'wallet.json'), JSON.stringify({ privateKey: key }), { mode: 0o600 }); }
const rpcPort = Number(process.env.LOCAL_RPC_PORT || 8545);
const appPort = Number(process.env.PORT || 5173);
const rpcUrl = 'http://127.0.0.1:' + rpcPort;
const chain = ganache.server({ chain: { chainId: 31337, hardfork: 'shanghai' },
  wallet: { accounts: [{ secretKey: key, balance: toBeHex(parseEther('1000')) }] },
  database: { dbPath: path.join(privateDir, 'chain') }, logging: { quiet: true } });
await chain.listen(rpcPort, '127.0.0.1');
const provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true });
const signer = new Wallet(key, provider);
const artifact = await compileContract();
let deployment;
try {
  deployment = JSON.parse(await fs.readFile(path.join(projectRoot, 'deployment-local.json'), 'utf8'));
  if ((await provider.getCode(deployment.contractAddress)).toLowerCase() !== artifact.deployedBytecode.toLowerCase()) deployment = null;
  if (deployment && (await new Contract(deployment.contractAddress, artifact.abi, provider).issuer()).toLowerCase() !== signer.address.toLowerCase()) deployment = null;
} catch { deployment = null; }
if (!deployment) {
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy();
  const receipt = await contract.deploymentTransaction().wait();
  deployment = { chainId: 31337, network: 'local-demo', contractAddress: await contract.getAddress(), issuer: signer.address,
    deploymentBlock: receipt.blockNumber, deployedAt: new Date().toISOString(), txHash: receipt.hash, rpcUrl, explorerUrl: '', abi: artifact.abi };
  await fs.writeFile(path.join(projectRoot, 'deployment-local.json'), JSON.stringify(deployment, null, 2) + '\n');
}
console.log('LOCAL DEMO ONLY — chain 31337. This is not a Monad testnet deployment.');
console.log('CrossCheck: http://localhost:' + appPort);
console.log('Local contract: ' + deployment.contractAddress);
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/start-legacy.ts'], { cwd: projectRoot, stdio: 'inherit',
  env: { ...process.env, PORT: String(appPort), HOST: process.env.HOST || '127.0.0.1',
    CHAIN_MODE: 'local', CHAIN_ID: '31337', RPC_URL: rpcUrl, PRIVATE_KEY: key,
    MODE: 'demo', BACKEND_ORIGIN: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
    CONTRACT_ADDRESS: deployment.contractAddress, ISSUER_ADDRESS: signer.address,
    DEPLOYMENT_BLOCK: String(deployment.deploymentBlock), DATA_DIR: path.join(projectRoot, 'data-local') } });
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  child.kill();
  await chain.close();
  provider.destroy();
  process.exit(code);
}
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
child.on('exit', code => close(code || 0));
