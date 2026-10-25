import { today } from '@app/domain';
import { buildMockServer } from './server.js';

const port = Number(process.env.MOCK_PORT ?? 4100);
const app = buildMockServer({ today: today() });
await app.listen({ port, host: '127.0.0.1' });
console.log(`mock-systems listening on http://127.0.0.1:${port}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
