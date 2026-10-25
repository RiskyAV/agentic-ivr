import { ConfigError, loadConfig, loadRootEnv } from './config.js';
import { buildApp } from './app.js';
import { checkModels, GeminiClient } from './platform/llm/gemini.js';

loadRootEnv();

let loaded: ReturnType<typeof loadConfig>;
try {
  loaded = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`[config] ${e.message}`);
    process.exit(1);
  }
  throw e;
}
const { config, warnings } = loaded;
for (const w of warnings) console.warn(`[config] ${w}`);

const handle = await buildApp(config);
const port = await handle.listen();
console.log(`server listening on :${port} (llm=${config.llmProvider}${config.llmProvider === 'gemini' ? `, model=${config.model}, guard=${config.guardModel}` : ''}, mocks=${config.mockBaseUrl})`);

if (config.llmProvider === 'gemini' && handle.llm instanceof GeminiClient) {
  checkModels(handle.llm, [config.model, config.guardModel])
    .then((missing) => {
      if (missing.length) console.warn(`[config] models not offered by the API: ${missing.join(', ')}`);
    })
    .catch((e) => console.warn(`[config] could not verify models: ${(e as Error).message}`));
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    void handle.close().then(() => process.exit(0), () => process.exit(1));
  });
}
