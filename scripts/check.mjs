import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const args of [
  ['scripts/build-web.mjs'],
  ['node_modules/typescript/bin/tsc', '--noEmit'],
  ['node_modules/typescript/bin/tsc', '-p', 'packages/protocol/tsconfig.json'],
  ['--import', 'tsx', 'packages/protocol/scripts/check-fixtures.ts'],
  ['scripts/test.mjs', '--built'],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
