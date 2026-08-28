import { config } from './config.js';
import { AppError, ServiceUnavailableError } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Circuit breaker.
 *
 * After N consecutive failures the breaker opens and calls fail fast for
 * `resetMs`, instead of every request piling up on a dying dependency. One
 * probe request is allowed through in half-open state to test recovery.
 */
export class CircuitBreaker {
  constructor({ name, threshold = 5, resetMs = 10_000 }) {
    this.name = name;
    this.threshold = threshold;
    this.resetMs = resetMs;
    this.failures = 0;
    this.state = 'closed'; // closed | open | half-open
    this.openedAt = 0;
  }

  canRequest() {
    if (this.state === 'closed') return true;
    if (this.state === 'open' && Date.now() - this.openedAt >= this.resetMs) {
      this.state = 'half-open';
      return true;
    }
    return this.state === 'half-open';
  }

  onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  onFailure() {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}

const breakers = new Map();
const breakerFor = (name) => {
  if (!breakers.has(name)) breakers.set(name, new CircuitBreaker({ name }));
  return breakers.get(name);
};

export function breakerStates() {
  return Object.fromEntries([...breakers].map(([n, b]) => [n, { state: b.state, failures: b.failures }]));
}

/**
 * Service-to-service HTTP client: timeout, retry with backoff (idempotent
 * methods only), circuit breaking, and identity/trace header propagation.
 */
export async function callService(
  baseUrl,
  path,
  { method = 'GET', body, headers = {}, timeoutMs = 3000, retries = 2, user, requestId, serviceName, raw = false } = {}
) {
  const name = serviceName || new URL(baseUrl).host;
  const breaker = breakerFor(name);

  if (!breaker.canRequest()) {
    throw new ServiceUnavailableError(`Circuit open for ${name}`, { service: name });
  }

  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const retryable = ['GET', 'HEAD', 'OPTIONS'].includes(method);
  const attempts = retryable ? retries + 1 : 1;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-internal-secret': config.auth.internalSecret,
          ...(requestId ? { 'x-request-id': requestId } : {}),
          ...(user?.id ? { 'x-user-id': user.id } : {}),
          ...(user?.email ? { 'x-user-email': user.email } : {}),
          ...(user?.roles ? { 'x-user-roles': user.roles.join(',') } : {}),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

      const text = await res.text();
      const payload = text ? JSON.parse(text) : null;

      if (!res.ok) {
        // 4xx is a real answer from a healthy service — do not trip the breaker.
        if (res.status < 500) {
          breaker.onSuccess();
          throw new AppError(payload?.error?.message || `Request failed (${res.status})`, {
            status: res.status,
            code: payload?.error?.code || 'UPSTREAM_ERROR',
            details: payload?.error?.details
          });
        }
        throw new ServiceUnavailableError(`${name} returned ${res.status}`, { service: name });
      }

      breaker.onSuccess();
      // `raw` keeps the upstream status code, which the gateway proxy needs in
      // order to pass 201/202/204 through instead of flattening everything to 200.
      return raw ? { status: res.status, body: payload } : payload;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof AppError && err.status < 500) throw err;
      lastError = err;
      breaker.onFailure();
      if (attempt < attempts) await sleep(100 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw new ServiceUnavailableError(`${name} unreachable: ${lastError?.message || 'unknown error'}`, {
    service: name
  });
}

/** Bind a base URL once: `const catalog = serviceClient(config.services.catalog, 'catalog')`. */
export function serviceClient(baseUrl, serviceName) {
  return {
    get: (path, opts = {}) => callService(baseUrl, path, { ...opts, method: 'GET', serviceName }),
    post: (path, body, opts = {}) => callService(baseUrl, path, { ...opts, method: 'POST', body, serviceName }),
    put: (path, body, opts = {}) => callService(baseUrl, path, { ...opts, method: 'PUT', body, serviceName }),
    del: (path, opts = {}) => callService(baseUrl, path, { ...opts, method: 'DELETE', serviceName })
  };
}
