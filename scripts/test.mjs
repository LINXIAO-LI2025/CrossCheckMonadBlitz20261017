import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv.includes('--built')) {
  const built = spawnSync(process.execPath, ['scripts/build-web.mjs'], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
const dirs = ['packages/protocol/test', 'packages/chain/test', 'apps/server/src', 'tests'];
const files = dirs.flatMap(dir => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter(name => name.endsWith('.test.ts')).map(name => `${dir}/${name}`));
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
