import express from 'express';
import { createLogger } from './logger.js';
import { requestId, requestLogger, errorHandler, notFound } from './middleware.js';
import { metrics } from './metrics.js';
import { config } from './config.js';

/**
 * Every service is built from this factory, so all nine expose the same
 * operational surface: /health, /health/ready, /metrics, request ids,
 * structured logs, JSON errors.
 */
export function createApp({ service, routes = [], checks = {}, mountMetrics = true } = {}) {
  const logger = createLogger(service);
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(requestId);
  app.use(requestLogger(logger));

  // Liveness: is the process up at all?
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service, uptimeSeconds: Math.floor(process.uptime()) });
  });

  // Readiness: can it actually serve traffic (deps reachable)?
  app.get('/health/ready', async (_req, res) => {
    const results = {};
    let ready = true;
    for (const [name, check] of Object.entries(checks)) {
      try {
        results[name] = (await check()) ? 'ok' : 'down';
      } catch {
        results[name] = 'down';
      }
      if (results[name] !== 'ok') ready = false;
    }
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not-ready',
      service,
      drivers: config.drivers,
      dependencies: results
    });
  });

  if (mountMetrics) {
    app.get('/metrics', (_req, res) => {
      res.set('content-type', 'text/plain; version=0.0.4').send(metrics.render());
    });
  }

  for (const { path, router } of routes) app.use(path, router);

  app.use(notFound);
  app.use(errorHandler(logger));

  app.locals.logger = logger;
  app.locals.service = service;
  return app;
}

/** Start an HTTP server with graceful shutdown wired up. */
export function startServer(app, port, { onShutdown } = {}) {
  const logger = app.locals.logger || createLogger(app.locals.service || 'service');
  const server = app.listen(port, () => {
    logger.info({ port, drivers: config.drivers }, `${app.locals.service} listening`);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close();
    try {
      await onShutdown?.();
    } catch (err) {
      logger.error({ err: err.message }, 'shutdown hook failed');
    }
    setTimeout(() => process.exit(0), 100).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}
