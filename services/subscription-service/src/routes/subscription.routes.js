import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, validate, internalOnly, internalUser, NotFoundError,
  ForbiddenError, TOPICS, EVENTS, createEvent, withCache, cacheKeys, config
} from '@streaming/shared';
import { PLANS, PLAN_IDS, getPlan, formatMinor } from '../domain/plans.js';
import { SAGA_GRAPH } from '../domain/saga-definition.js';

const subscribeSchema = z.object({
  planId: z.enum(PLAN_IDS),
  paymentMethod: z
    .object({
      cardNumber: z.string().min(4).max(19).optional(),
      holder: z.string().max(60).optional(),
      forceFail: z.boolean().optional()
    })
    .default({})
});

const toApi = (s) => ({
  id: s.id,
  userId: s.user_id,
  planId: s.plan_id,
  status: s.status,
  priceMinor: s.price_minor,
  price: formatMinor(s.price_minor, s.currency),
  currency: s.currency,
  currentPeriodStart: s.current_period_start,
  currentPeriodEnd: s.current_period_end,
  paymentId: s.payment_id,
  failureReason: s.failure_reason,
  cancelledAt: s.cancelled_at,
  createdAt: s.created_at
});

export function createSubscriptionRouter({ repo, bus, cache, orchestrator }) {
  const router = Router();
  router.use(internalOnly);

  /** Public plan catalogue — no identity needed. */
  router.get('/plans', (_req, res) => {
    res.json({
      plans: Object.values(PLANS).map((p) => ({ ...p, price: formatMinor(p.priceMinor, p.currency) }))
    });
  });

  /** The saga's shape, so the docs and a debug UI stay in sync with the code. */
  router.get('/saga-graph', (_req, res) => {
    res.json({ sagaType: 'SUBSCRIBE', transitions: SAGA_GRAPH.map(([from, to, trigger]) => ({ from, to, trigger })) });
  });

  /**
   * POST /subscriptions — starts the Subscribe Saga.
   *
   * Returns 202 Accepted, not 201: the subscription is *pending* until billing
   * replies. The client polls GET /subscriptions/:id (or waits for a notification).
   */
  router.post(
    '/',
    internalUser,
    validate({ body: subscribeSchema }),
    asyncHandler(async (req, res) => {
      const idempotencyKey = req.headers['idempotency-key'];

      // Retrying a POST with the same key returns the original result instead of
      // starting a second saga (and a second charge).
      if (idempotencyKey) {
        const previous = await repo.findIdempotentResult(`subscribe:${req.user.id}:${idempotencyKey}`);
        if (previous) return res.status(202).json({ ...previous, idempotentReplay: true });
      }

      const result = await orchestrator.begin({
        userId: req.user.id,
        planId: req.body.planId,
        paymentMethod: req.body.paymentMethod,
        correlationId: req.id
      });

      if (idempotencyKey) {
        await repo.saveIdempotentResult(`subscribe:${req.user.id}:${idempotencyKey}`, result);
      }

      res.status(202).json(result);
    })
  );

  /** The user's own subscriptions. */
  router.get(
    '/',
    internalUser,
    asyncHandler(async (req, res) => {
      const items = await repo.listByUser(req.user.id);
      res.json({ items: items.map(toApi) });
    })
  );

  /**
   * GET /subscriptions/entitlement — the hot path.
   *
   * playback-service calls this before every stream, so it is cached in Redis
   * and invalidated whenever the subscription changes.
   */
  router.get(
    '/entitlement',
    internalUser,
    asyncHandler(async (req, res) => {
      const userId = req.user.id;

      const { value, cached } = await withCache(
        cacheKeys.entitlement(userId),
        config.cacheTtl.entitlement,
        async () => {
          const active = await repo.findActiveByUser(userId);
          if (!active) {
            return { userId, entitled: false, planId: null, reason: 'no_active_subscription' };
          }
          const plan = getPlan(active.plan_id);
          return {
            userId,
            entitled: true,
            subscriptionId: active.id,
            planId: plan.id,
            planName: plan.name,
            maxStreams: plan.maxStreams,
            maxQuality: plan.maxQuality,
            downloads: plan.downloads,
            currentPeriodEnd: active.current_period_end
          };
        },
        { cache }
      );

      res.json({ ...value, cached });
    })
  );

  /** Saga instances, for debugging and for the demo script. */
  router.get(
    '/sagas',
    asyncHandler(async (_req, res) => {
      const sagas = await repo.listSagas({ limit: 50 });
      res.json({
        items: sagas.map((s) => ({
          id: s.id,
          type: s.saga_type,
          state: s.state,
          subscriptionId: s.subscription_id,
          userId: s.user_id,
          history: s.history,
          createdAt: s.created_at,
          updatedAt: s.updated_at
        }))
      });
    })
  );

  router.get(
    '/sagas/:id',
    asyncHandler(async (req, res) => {
      const saga = await repo.findSaga(req.params.id);
      if (!saga) throw new NotFoundError('Saga not found');
      res.json({ saga });
    })
  );

  router.get(
    '/:id',
    internalUser,
    asyncHandler(async (req, res) => {
      const sub = await repo.findSubscription(req.params.id);
      if (!sub) throw new NotFoundError('Subscription not found');
      if (sub.user_id !== req.user.id) throw new ForbiddenError('Not your subscription');

      const saga = await repo.findSagaBySubscription(sub.id);
      res.json({ subscription: toApi(sub), saga: saga ? { id: saga.id, state: saga.state, history: saga.history } : null });
    })
  );

  /**
   * Cancel. A single local transaction plus an event — no saga needed, because
   * nothing outside this service has to change for it to be correct.
   */
  router.post(
    '/:id/cancel',
    internalUser,
    asyncHandler(async (req, res) => {
      const sub = await repo.findSubscription(req.params.id);
      if (!sub) throw new NotFoundError('Subscription not found');
      if (sub.user_id !== req.user.id) throw new ForbiddenError('Not your subscription');
      if (sub.status !== 'active') throw new ForbiddenError(`Cannot cancel a ${sub.status} subscription`);

      const updated = await repo.updateSubscription(sub.id, {
        status: 'cancelled',
        cancelled_at: new Date().toISOString()
      });

      // Entitlement is cached — drop it now so playback stops immediately.
      await cache.del(cacheKeys.entitlement(sub.user_id));

      await bus.publish(
        TOPICS.SUBSCRIPTION_EVENTS,
        createEvent(
          EVENTS.SUBSCRIPTION_CANCELLED,
          { subscriptionId: sub.id, userId: sub.user_id, planId: sub.plan_id },
          { key: sub.user_id, correlationId: req.id }
        )
      );

      res.json({ subscription: toApi(updated) });
    })
  );

  return router;
}
