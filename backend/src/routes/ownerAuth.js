import { Router } from 'express';
import { getById } from '../db.js';
import { verifyOwnerPassword, getLockInfo } from '../services/ownerAuth.js';

const router = Router();

/**
 * Verify the prototype owner operation password.
 * POST /api/projects/:id/owner-auth/verify  { password }
 *  - 200: { ok: true, token, expiresIn, expiresAt }
 *  - 401: { error: 'OWNER_AUTH_INVALID'|'OWNER_AUTH_LOCKED', message, remainingAttempts, lock }
 */
router.post('/:id/owner-auth/verify', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const result = await verifyOwnerPassword(req.params.id, req.body?.password);
  if (!result.ok) {
    return res.status(401).json({
      error: result.error,
      message: result.message,
      remainingAttempts: result.remainingAttempts,
      lock: {
        locked: !!result.locked,
        lockedUntil: result.lockedUntil || 0,
        remainingLockMs: result.remainingLockMs || 0
      }
    });
  }
  res.json({
    ok: true,
    token: result.token,
    expiresIn: result.expiresIn,
    expiresAt: result.expiresAt
  });
});

/**
 * Read-only lock status (so the UI can show a lockout banner without trying).
 * GET /api/projects/:id/owner-auth/status
 */
router.get('/:id/owner-auth/status', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(await getLockInfo(req.params.id));
});

export default router;
