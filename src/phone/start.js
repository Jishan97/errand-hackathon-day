import { createRuntime } from './server.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const runtime = createRuntime({ config });
runtime.server.listen(config.port, '127.0.0.1', () => console.info('Errand phone runtime listening on localhost.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => runtime.close());
