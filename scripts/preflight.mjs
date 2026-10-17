import path from 'node:path';
import { config } from 'dotenv';
import { JsonRpcProvider, Wallet, formatEther } from 'ethers';
import { projectRoot } from './compile.mjs';
config({ path: path.join(projectRoot, '.env'), quiet: true });
const result = {
  node: process.version, openaiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
  anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  openaiModelConfigured: Boolean(process.env.OPENAI_MODEL), anthropicModelConfigured: Boolean(process.env.ANTHROPIC_MODEL),
  sponsorAddress: process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY).address : null,
  contractAddress: process.env.CONTRACT_ADDRESS || null, chainId: null, testMonBalance: null, error: null
};
const provider = new JsonRpcProvider(process.env.RPC_URL || 'https://testnet-rpc.monad.xyz');
try {
  const chainId = (await provider.getNetwork()).chainId;
  result.chainId = Number(chainId);
  if (chainId !== 10143n) throw new Error('Expected Monad testnet 10143; public-network deployment disabled on other chains.');
  if (result.sponsorAddress) result.testMonBalance = formatEther(await provider.getBalance(result.sponsorAddress));
  if (result.contractAddress && await provider.getCode(result.contractAddress) === '0x') throw new Error('Configured contract address has no code.');
} catch (error) { result.error = error.shortMessage || error.message; }
finally { provider.destroy(); }
console.log(JSON.stringify(result, null, 2));
if (result.error) process.exitCode = 1;
