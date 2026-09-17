import { Router } from 'express';
import { asyncHandler, internalUser, NotFoundError, internalOnly } from '@streaming/shared';
import { formatMinor } from '../../../subscription-service/src/domain/plans.js';

export function createBillingRouter({ repo }) {
  const router = Router();
  router.use(internalOnly);

  /** Payment history for the calling user. */
  router.get(
    '/payments',
    internalUser,
    asyncHandler(async (req, res) => {
      const payments = await repo.listByUser(req.user.id);
      res.json({
        items: payments.map((p) => ({
          id: p.id,
          subscriptionId: p.subscription_id,
          amountMinor: p.amount_minor,
          amount: formatMinor(p.amount_minor, p.currency),
          currency: p.currency,
          status: p.status,
          failureReason: p.failure_reason,
          refundId: p.refund_id,
          createdAt: p.created_at
        }))
      });
    })
  );

  router.get(
    '/payments/:id',
    internalUser,
    asyncHandler(async (req, res) => {
      const payment = await repo.findPayment(req.params.id);
      if (!payment || payment.user_id !== req.user.id) throw new NotFoundError('Payment not found');
      res.json({ payment });
    })
  );

  return router;
}
