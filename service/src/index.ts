import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const config = loadConfig();
const app = await buildApp(config);

// Cloud Run sends SIGTERM before stopping an instance; finish in-flight requests first.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: '0.0.0.0', port: config.PORT });
