import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, validate, prefixedId, signToken,
  ConflictError, UnauthorizedError, NotFoundError, BadRequestError,
  TOPICS, EVENTS, createEvent, internalUser
} from '@streaming/shared';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../domain/password.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(60),
  country: z.string().length(2).default('IN')
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
  country: u.country,
  createdAt: u.created_at
});

export function createAuthRouter({ repo, bus }) {
  const router = Router();

  router.post(
    '/register',
    validate({ body: registerSchema }),
    asyncHandler(async (req, res) => {
      const { email, password, displayName, country } = req.body;

      const strength = validatePasswordStrength(password);
      if (!strength.valid) throw new BadRequestError('Weak password', strength.problems);

      if (await repo.findByEmail(email)) throw new ConflictError('Email already registered');

      const user = {
        id: prefixedId('usr'),
        email,
        password_hash: await hashPassword(password),
        display_name: displayName,
        country,
        created_at: new Date().toISOString()
      };

      let created;
      try {
        created = await repo.create(user);
      } catch (err) {
        // Unique-index violation: another request registered the same email first.
        if (err.code === '23505') throw new ConflictError('Email already registered');
        throw err;
      }

      // Fact for the rest of the platform: notification-service sends a welcome
      // message, recommendation-service can bootstrap a cold-start profile.
      await bus.publish(
        TOPICS.USER_EVENTS,
        createEvent(EVENTS.USER_REGISTERED, { userId: user.id, email, displayName, country }, {
          key: user.id,
          correlationId: req.id
        })
      );

      res.status(201).json({
        user: publicUser(created),
        token: signToken({ sub: user.id, email, roles: ['user'] })
      });
    })
  );

  router.post(
    '/login',
    validate({ body: loginSchema }),
    asyncHandler(async (req, res) => {
      const { email, password } = req.body;
      const user = await repo.findByEmail(email);

      // Same error for "no such user" and "wrong password", so the endpoint does
      // not leak which email addresses are registered.
      const ok = user ? await verifyPassword(password, user.password_hash) : false;
      if (!user || !ok) throw new UnauthorizedError('Invalid email or password');

      res.json({
        user: publicUser(user),
        token: signToken({ sub: user.id, email: user.email, roles: ['user'] })
      });
    })
  );

  return router;
}

export function createUserRouter({ repo }) {
  const router = Router();

  // Every /users route requires the internal secret AND a gateway-forwarded
  // identity. A downstream service never trusts a raw end-user JWT.
  router.use(internalUser);

  router.get(
    '/me',
    asyncHandler(async (req, res) => {
      const user = await repo.findById(req.user.id);
      if (!user) throw new NotFoundError('User not found');
      res.json({ user: publicUser(user) });
    })
  );

  router.put(
    '/me',
    validate({
      body: z.object({
        displayName: z.string().min(1).max(60).optional(),
        country: z.string().length(2).optional()
      })
    }),
    asyncHandler(async (req, res) => {
      const updated = await repo.updateProfile(req.user.id, {
        display_name: req.body.displayName,
        country: req.body.country
      });
      if (!updated) throw new NotFoundError('User not found');
      res.json({ user: publicUser(updated) });
    })
  );

  // Internal lookup remains scoped to the forwarded user identity.
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const user = req.params.id === req.user.id ? await repo.findById(req.params.id) : null;
      if (!user) throw new NotFoundError('User not found');
      res.json({ user: publicUser(user) });
    })
  );

  return router;
}
