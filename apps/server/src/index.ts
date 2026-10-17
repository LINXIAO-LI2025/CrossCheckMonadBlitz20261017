import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';
import { createGateway } from './chain.js';
import { loadConfig } from './config.js';
import { JobService } from './service.js';
import { JobStore } from './store.js';

async function main() {
  const config = await loadConfig();
  const service = new JobService(config, new JobStore(config.data_dir), createGateway(config));
  await service.init();
  const { app, closeStreams } = createApp(service);
  const server = app.listen(config.port, config.host, () => {
    console.log(`CrossCheck backend http://${config.host}:${config.port} mode=${config.mode}`);
    if (config.host === '0.0.0.0') {
      for (const entries of Object.values(networkInterfaces())) for (const address of entries ?? []) {
        if (address.family === 'IPv4' && !address.internal) console.log(`LAN backend: http://${address.address}:${config.port}`);
      }
    }
    console.log('A model opinion is not factual proof; demo results are fixtures and never broadcast.');
  });
  server.on('error', async () => { console.error('SERVER_LISTEN_FAILED'); await service.close(); process.exitCode = 1; });
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true; closeStreams(); server.close();
    await service.close();
  }
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}
main().catch(() => { console.error('STARTUP_FAILED: Check configuration, deployment.json and data directory lock.'); process.exitCode = 1; });
