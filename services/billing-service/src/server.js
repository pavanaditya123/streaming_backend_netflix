import { bootstrap, startServer, config } from '@streaming/shared';
import { createBillingApp } from './app.js';

const { bus, shutdown } = await bootstrap('billing-service');
const app = createBillingApp({ bus });

startServer(app, config.ports.billing, { onShutdown: shutdown });
