import { bootstrap, startServer, config } from '@streaming/shared';
import { createUserApp } from './app.js';

const { bus, shutdown } = await bootstrap('user-service');
const app = createUserApp({ bus });

startServer(app, config.ports.user, { onShutdown: shutdown });
