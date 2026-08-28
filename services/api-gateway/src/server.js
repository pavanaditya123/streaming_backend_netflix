import { bootstrap, startServer, config } from '@streaming/shared';
import { createGatewayApp } from './app.js';

const { cache, shutdown } = await bootstrap('api-gateway');
const app = createGatewayApp({ cache });

startServer(app, config.ports.gateway, { onShutdown: shutdown });
