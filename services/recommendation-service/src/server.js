import { bootstrap, startServer, config } from '@streaming/shared';
import { createRecommendationApp } from './app.js';

const { cache, shutdown } = await bootstrap('recommendation-service');
const app = createRecommendationApp({ cache });

startServer(app, config.ports.recommendation, { onShutdown: shutdown });
