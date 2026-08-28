import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AppError, BadRequestError, NotFoundError } from './errors.js';
import { metrics } from './metrics.js';

/** Attach/propagate a request id so one user action is traceable across services. */
export function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}

export function requestLogger(logger) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    req.log = logger.child({ requestId: req.id });

    // Stamp the timing header just before headers flush — doing it on 'finish'
    // is too late, the response is already on the wire.
    const writeHead = res.writeHead;
    res.writeHead = function patchedWriteHead(...args) {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (!this.headersSent) this.setHeader('x-response-time-ms', ms.toFixed(1));
      return writeHead.apply(this, args);
    };

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;
      metrics.httpRequests.inc({ method: req.method, route, status: res.statusCode });
      metrics.httpDuration.observe({ method: req.method, route }, ms);
      req.log.info(
        { method: req.method, path: req.originalUrl, status: res.statusCode, ms: Number(ms.toFixed(1)) },
        'request'
      );
    });
    next();
  };
}

/** Validate `body` / `query` / `params` with a Zod schema. */
export function validate(schemas) {
  return (req, _res, next) => {
    try {
      for (const part of ['body', 'query', 'params']) {
        if (schemas[part]) {
          const parsed = schemas[part].parse(req[part]);
          if (part === 'query') req.validatedQuery = parsed;
          else req[part] = parsed;
        }
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(
          new BadRequestError(
            'Validation failed',
            err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
          )
        );
      } else next(err);
    }
  };
}

export function notFound(req, _res, next) {
  next(new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`));
}

/** Single place where an error becomes an HTTP response. */
export function errorHandler(logger) {
  return (err, req, res, _next) => {
    const status = err instanceof AppError ? err.status : err.status || 500;
    const code = err.code || 'INTERNAL_ERROR';
    const log = req.log || logger;

    if (status >= 500) log.error({ err: err.message, stack: err.stack, code }, 'request failed');
    else log.warn({ err: err.message, code }, 'request rejected');

    res.status(status).json({
      error: {
        code,
        message: status >= 500 ? 'Internal server error' : err.message,
        details: err.details,
        requestId: req.id
      }
    });
  };
}

/** Wrap an async route handler so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Naive fixed-window rate limiter backed by the cache adapter. */
export function rateLimit({ cache, limit = 100, windowSeconds = 60, keyFn }) {
  return async (req, res, next) => {
    try {
      const id = keyFn ? keyFn(req) : req.user?.id || req.ip;
      const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
      const count = await cache.incr(`ratelimit:${id}:${bucket}`, windowSeconds);
      res.setHeader('x-ratelimit-limit', limit);
      res.setHeader('x-ratelimit-remaining', Math.max(0, limit - count));
      if (count > limit) {
        return res.status(429).json({
          error: { code: 'RATE_LIMITED', message: 'Too many requests', requestId: req.id }
        });
      }
      return next();
    } catch {
      return next(); // never fail a request because the limiter itself broke
    }
  };
}
