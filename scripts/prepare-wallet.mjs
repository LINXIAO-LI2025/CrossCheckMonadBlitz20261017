import fs from 'node:fs/promises';
import path from 'node:path';
import { Wallet } from 'ethers';
import { parse } from 'dotenv';
import { projectRoot } from './compile.mjs';

const envPath = path.join(projectRoot, '.env');
let existing = '';
try { existing = await fs.readFile(envPath, 'utf8'); } catch {}
const current = parse(existing);
if (current.PRIVATE_KEY) {
  const wallet = new Wallet(current.PRIVATE_KEY);
  console.log(JSON.stringify({ address: wallet.address, chainId: 10143, keyExists: true }));
} else {
  const wallet = Wallet.createRandom();
  const additions = {
    PRIVATE_KEY: wallet.privateKey, ISSUER_ADDRESS: wallet.address,
    RPC_URL: current.RPC_URL || 'https://testnet-rpc.monad.xyz', CHAIN_ID: current.CHAIN_ID || '10143',
    CHAIN_MODE: current.CHAIN_MODE || 'monad', PORT: current.PORT || '5173', HOST: current.HOST || '127.0.0.1'
  };
  let next = existing;
  for (const [name, value] of Object.entries(additions)) {
    const line = name + '=' + value;
    const expression = new RegExp('^' + name + '=.*$', 'm');
    if (expression.test(next)) next = next.replace(expression, line);
    else next += (next.endsWith('\n') || !next ? '' : '\n') + line + '\n';
  }
  await fs.writeFile(envPath, next, { mode: 0o600 });
  console.log(JSON.stringify({ address: wallet.address, chainId: 10143, keyExists: false,
    note: 'New testnet-only sponsor wallet saved locally. Private key is never printed.' }));
}
