import { bootstrap, startServer, config } from '@streaming/shared';
import { createNotificationApp } from './app.js';

const { bus, shutdown } = await bootstrap('notification-service');
const app = createNotificationApp({ bus });

startServer(app, config.ports.notification, { onShutdown: shutdown });
