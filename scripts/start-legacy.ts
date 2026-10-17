import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
// Capture caller overrides before B's dotenv side effect reads A's root .env.
// A's default PORT/DATA_DIR in that file must not make legacy share its listener/storage.
const callerPort = process.env.PORT;
const callerDataDir = process.env.DATA_DIR;
const callerPublicOrigin = process.env.PUBLIC_ORIGIN;
const { createCrossCheckServer, loadServerConfig } = await import('../server');
const config = loadServerConfig({
  ...process.env,
  PORT: callerPort || '5174',
  DATA_DIR: callerDataDir || 'data-legacy',
  PUBLIC_ORIGIN: callerPublicOrigin || '',
}, rootDir);
if (!callerPublicOrigin) config.publicOrigin = `http://localhost:${config.port}`;
const service = await createCrossCheckServer({ config, static_root: path.join(rootDir, 'legacy', 'b-web') });
const server = service.app.listen(config.port, config.host, () => {
  console.log(`CrossCheck legacy B: http://localhost:${config.port} (${config.mode}; camelCase API; data=${config.dataDir})`);
});
server.on('error', error => {
  console.error(`Legacy B service could not start: ${error.message}`);
  service.close();
  process.exitCode = 1;
});
