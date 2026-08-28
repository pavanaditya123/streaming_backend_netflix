import pino from 'pino';
import { config } from './config.js';

export const rootLogger = pino({
  level: config.logLevel,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime
});

export function createLogger(service) {
  return rootLogger.child({ service });
}
