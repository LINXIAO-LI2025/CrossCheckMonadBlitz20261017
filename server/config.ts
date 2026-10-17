import path from 'node:path';

export interface ServerConfig {
  rootDir: string;
  dataDir: string;
  port: number;
  host: string;
  publicOrigin: string;
  mode: 'demo' | 'live';
  chainMode: 'local' | 'monad' | 'unconfigured';
  chainId: number;
  rpcUrl: string;
  contractAddress: string;
  issuerAddress: string;
  privateKey: string;
  deploymentBlock: string;
  explorerUrl: string;
  backendOrigin: string;
  openaiKey: string;
  anthropicKey: string;
  openaiModel: string;
  anthropicModel: string;
  modelTimeoutMs: number;
  maxActiveJobs: number;
  demoDelayMs: number;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env, rootDir = process.cwd()): ServerConfig {
  const chainMode = env.CHAIN_MODE === 'local' || env.CHAIN_MODE === 'monad' ? env.CHAIN_MODE : 'unconfigured';
  const positive = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    rootDir: path.resolve(rootDir), dataDir: path.resolve(rootDir, env.DATA_DIR || 'data'),
    port: positive(env.PORT, 5173), host: env.HOST || '127.0.0.1', publicOrigin: (env.PUBLIC_ORIGIN || '').replace(/\/$/, ''),
    mode: env.MODE === 'live' ? 'live' : 'demo',
    chainMode, chainId: positive(env.CHAIN_ID, chainMode === 'local' ? 31337 : 10143),
    rpcUrl: env.RPC_URL || '', contractAddress: env.CONTRACT_ADDRESS || '',
    issuerAddress: env.ISSUER_ADDRESS || '', privateKey: env.PRIVATE_KEY || '',
    deploymentBlock: env.DEPLOYMENT_BLOCK || '0',
    explorerUrl: env.EXPLORER_URL || (chainMode === 'monad' ? 'https://testnet.monadexplorer.com' : ''),
    backendOrigin: (env.BACKEND_ORIGIN || '').replace(/\/$/, ''),
    openaiKey: env.OPENAI_API_KEY || '', anthropicKey: env.ANTHROPIC_API_KEY || '',
    openaiModel: env.OPENAI_MODEL || '', anthropicModel: env.ANTHROPIC_MODEL || '',
    modelTimeoutMs: Math.min(positive(env.MODEL_TIMEOUT_MS, 45000), 120000),
    maxActiveJobs: Math.min(positive(env.MAX_ACTIVE_JOBS, 8), 32),
    demoDelayMs: Math.min(positive(env.DEMO_DELAY_MS, 350), 3000),
  };
}

export function liveAvailable(config: ServerConfig) {
  return Boolean(config.openaiKey && config.anthropicKey && config.openaiModel && config.anthropicModel);
}

export function chainConfigured(config: ServerConfig) {
  return config.chainMode !== 'unconfigured' && Boolean(config.rpcUrl && config.privateKey && config.contractAddress);
}
