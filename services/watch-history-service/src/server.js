import { bootstrap, startServer, config } from '@streaming/shared';
import { createWatchHistoryApp } from './app.js';

const { bus, cache, shutdown } = await bootstrap('watch-history-service');
const app = createWatchHistoryApp({ cache, bus });

startServer(app, config.ports.watchHistory, { onShutdown: shutdown });
