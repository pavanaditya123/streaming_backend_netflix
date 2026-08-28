import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate, internalOnly, internalUser, NotFoundError } from '@streaming/shared';

const toApi = (n) => ({
  id: n.id,
  channel: n.channel,
  category: n.category,
  subject: n.subject,
  body: n.body,
  read: Boolean(n.read_at),
  sourceEventType: n.source_event_type,
  createdAt: n.created_at
});

export function createNotificationRouter({ repo }) {
  const router = Router();
  router.use(internalOnly, internalUser);

  router.get(
    '/',
    validate({
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
        unreadOnly: z.coerce.boolean().default(false)
      })
    }),
    asyncHandler(async (req, res) => {
      const { limit, offset, unreadOnly } = req.validatedQuery;
      const { items, total } = await repo.listByUser(req.user.id, { limit, offset, unreadOnly });
      res.json({ items: items.map(toApi), total, limit, offset });
    })
  );

  router.get(
    '/unread-count',
    asyncHandler(async (req, res) => {
      res.json({ count: await repo.unreadCount(req.user.id) });
    })
  );

  router.post(
    '/:id/read',
    asyncHandler(async (req, res) => {
      const updated = await repo.markRead(req.params.id, req.user.id);
      if (!updated) throw new NotFoundError('Notification not found');
      res.json({ notification: toApi(updated) });
    })
  );

  router.post(
    '/read-all',
    asyncHandler(async (req, res) => {
      res.json({ updated: await repo.markAllRead(req.user.id) });
    })
  );

  return router;
}
