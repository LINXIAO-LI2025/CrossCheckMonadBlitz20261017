import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

export const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function compileContract() {
  const source = await fs.readFile(path.join(projectRoot, 'CrossCheck.sol'), 'utf8');
  const input = { language: 'Solidity', sources: { 'CrossCheck.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const failures = (output.errors || []).filter(error => error.severity === 'error');
  if (failures.length) throw new Error(failures.map(error => error.formattedMessage).join('\n'));
  const compiled = output.contracts['CrossCheck.sol'].CrossCheck;
  const artifact = { contractName: 'CrossCheck', compiler: solc.version(), abi: compiled.abi,
    bytecode: '0x' + compiled.evm.bytecode.object, deployedBytecode: '0x' + compiled.evm.deployedBytecode.object };
  await fs.mkdir(path.join(projectRoot, 'artifacts'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'artifacts', 'CrossCheck.json'), JSON.stringify(artifact, null, 2) + '\n');
  return artifact;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifact = await compileContract();
  console.log('CrossCheck compiled with ' + artifact.compiler);
}
