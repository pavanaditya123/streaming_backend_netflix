/**
 * Central environment configuration.
 *
 * Every external dependency is selected by a *driver* string so the whole
 * platform can boot with zero infrastructure (memory) or against real
 * infrastructure (postgres/redis/kafka) without a single code change.
 */

const bool = (v, fallback = false) => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const int = (v, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  env: process.env.NODE_ENV || 'development',
  isTest: process.env.NODE_ENV === 'test',
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),

  // ---- driver selection -------------------------------------------------
  drivers: {
    data: process.env.DATA_DRIVER || 'memory', // memory | postgres
    cache: process.env.CACHE_DRIVER || 'memory', // memory | redis
    bus: process.env.BUS_DRIVER || 'memory' // memory | kafka
  },

  postgres: {
    url: process.env.DATABASE_URL || 'postgres://streaming:streaming@localhost:5432/streaming',
    poolMax: int(process.env.PG_POOL_MAX, 10),
    statementTimeoutMs: int(process.env.PG_STATEMENT_TIMEOUT_MS, 10_000)
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'sb:'
  },

  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',').map((s) => s.trim()),
    clientId: process.env.KAFKA_CLIENT_ID || 'streaming-backend'
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET || 'dev-only-jwt-secret-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
    // Shared secret proving a request came through the gateway, not the open internet.
    internalSecret: process.env.INTERNAL_SECRET || 'dev-only-internal-secret'
  },

  cacheTtl: {
    title: int(process.env.TTL_TITLE, 300),
    trending: int(process.env.TTL_TRENDING, 60),
    entitlement: int(process.env.TTL_ENTITLEMENT, 300),
    continueWatching: int(process.env.TTL_CONTINUE_WATCHING, 60),
    recommendation: int(process.env.TTL_RECOMMENDATION, 120),
    home: int(process.env.TTL_HOME, 30)
  },

  cacheEnabled: bool(process.env.CACHE_ENABLED, true),

  // Service discovery. In Docker these become container hostnames.
  services: {
    gateway: process.env.GATEWAY_URL || 'http://localhost:3000',
    user: process.env.USER_SERVICE_URL || 'http://localhost:3001',
    catalog: process.env.CATALOG_SERVICE_URL || 'http://localhost:3002',
    playback: process.env.PLAYBACK_SERVICE_URL || 'http://localhost:3003',
    watchHistory: process.env.WATCH_HISTORY_SERVICE_URL || 'http://localhost:3004',
    subscription: process.env.SUBSCRIPTION_SERVICE_URL || 'http://localhost:3005',
    billing: process.env.BILLING_SERVICE_URL || 'http://localhost:3006',
    notification: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3007',
    recommendation: process.env.RECOMMENDATION_SERVICE_URL || 'http://localhost:3008'
  },

  ports: {
    gateway: int(process.env.PORT_GATEWAY, 3000),
    user: int(process.env.PORT_USER, 3001),
    catalog: int(process.env.PORT_CATALOG, 3002),
    playback: int(process.env.PORT_PLAYBACK, 3003),
    watchHistory: int(process.env.PORT_WATCH_HISTORY, 3004),
    subscription: int(process.env.PORT_SUBSCRIPTION, 3005),
    billing: int(process.env.PORT_BILLING, 3006),
    notification: int(process.env.PORT_NOTIFICATION, 3007),
    recommendation: int(process.env.PORT_RECOMMENDATION, 3008)
  },

  billing: {
    // Deterministic failure hook so the saga's compensation path is demoable.
    failOnAmountAbove: int(process.env.BILLING_FAIL_ABOVE, 100_000),
    failForCardSuffix: process.env.BILLING_FAIL_CARD_SUFFIX || '0000'
  }
};

export { bool as parseBool, int as parseInt10 };
