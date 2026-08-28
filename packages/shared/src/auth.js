import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { UnauthorizedError, ForbiddenError } from './errors.js';

export function signToken(payload, { expiresIn = config.auth.jwtExpiresIn } = {}) {
  return jwt.sign(payload, config.auth.jwtSecret, { expiresIn });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.auth.jwtSecret);
  } catch (err) {
    throw new UnauthorizedError(err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
  }
}

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Edge authentication — used by the API gateway.
 * Verifies the JWT and attaches `req.user`.
 */
export function authenticate(req, _res, next) {
  const token = bearer(req);
  if (!token) return next(new UnauthorizedError('Missing bearer token'));
  try {
    const claims = verifyToken(token);
    req.user = { id: claims.sub, email: claims.email, roles: claims.roles || ['user'] };
    return next();
  } catch (err) {
    return next(err);
  }
}

export function optionalAuthenticate(req, _res, next) {
  if (!bearer(req)) return next();
  return authenticate(req, _res, next);
}

export function requireRole(role) {
  return (req, _res, next) => {
    if (!req.user?.roles?.includes(role)) return next(new ForbiddenError(`Requires role: ${role}`));
    return next();
  };
}

/**
 * Internal-service trust boundary.
 *
 * Downstream services never see the end-user JWT. The gateway validates it once
 * and forwards the identity in `x-user-id` alongside a shared internal secret,
 * so a service will not accept a spoofed identity from outside the mesh.
 */
export function internalAuth({ required = true } = {}) {
  return (req, _res, next) => {
    const secret = req.headers['x-internal-secret'];
    if (secret !== config.auth.internalSecret) {
      return next(new ForbiddenError('Invalid internal service credentials'));
    }
    const userId = req.headers['x-user-id'];
    if (userId) {
      req.user = {
        id: userId,
        email: req.headers['x-user-email'] || null,
        roles: String(req.headers['x-user-roles'] || 'user').split(',').filter(Boolean)
      };
    } else if (required) {
      return next(new UnauthorizedError('Missing forwarded user identity'));
    }
    return next();
  };
}

export const internalOnly = internalAuth({ required: false });
export const internalUser = internalAuth({ required: true });
