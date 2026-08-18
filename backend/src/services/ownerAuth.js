/**
 * Prototype owner operation password verification.
 *
 * Guards owner-level operations (project maintenance, file upload, prototype
 * deployment, plan review and plan apply). Design:
 *
 * 1. Configurable password  - read from env at call time (OWNER_PASSWORD), with
 *    a documented default fallback so the demo works out of the box. Real
 *    deployments should set OWNER_PASSWORD (and OWNER_AUTH_SECRET) in the
 *    platform environment, NOT by editing business code.
 * 2. One-time verification - after a successful password check the server
 *    issues an HMAC-signed token (payload + expiry). The frontend keeps it in
 *    sessionStorage and attaches it to subsequent protected calls. Stateless
 *    across serverless instances (no server-side session required). When the
 *    browser session ends (tab closed -> sessionStorage cleared) or the token
 *    expires (OWNER_AUTH_TTL_MS), verification is required again.
 * 3. Failure lockout       - consecutive failures are counted per project and
 *    persisted in the `ownerAuth` table (works across instances). After
 *    OWNER_AUTH_MAX_ATTEMPTS failures the project is locked for
 *    OWNER_AUTH_LOCK_MS; even a correct password is rejected while locked.
 * 4. Role scoping          - only the owner role is gated. If a request carries
 *    X-Role with a non-owner value (e.g. "reviewer"), the check is skipped so a
 *    future multi-role system can let other roles keep their existing behavior.
 */
import crypto from 'crypto';
import { getById, query, insert, update } from '../db.js';

const DEFAULT_PASSWORD = 'gugugaga2026';
const DEFAULT_SECRET = 'protobuddy-owner-auth-secret';
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;        // session validity: 8h
const DEFAULT_MAX_ATTEMPTS = 5;                    // consecutive failures before lock
const DEFAULT_LOCK_MS = 5 * 60 * 1000;             // lock duration: 5min

/** Read config lazily so env set by the Makers entry (or the platform) is honored. */
export function getOwnerConfig() {
  return {
    password: process.env.OWNER_PASSWORD || DEFAULT_PASSWORD,
    secret: process.env.OWNER_AUTH_SECRET || DEFAULT_SECRET,
    ttlMs: parseInt(process.env.OWNER_AUTH_TTL_MS || '', 10) || DEFAULT_TTL_MS,
    maxAttempts: parseInt(process.env.OWNER_AUTH_MAX_ATTEMPTS || '', 10) || DEFAULT_MAX_ATTEMPTS,
    lockMs: parseInt(process.env.OWNER_AUTH_LOCK_MS || '', 10) || DEFAULT_LOCK_MS
  };
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ---------------------------------- tokens --------------------------------- */

function sign(payloadB64) {
  return crypto.createHmac('sha256', getOwnerConfig().secret).update(payloadB64).digest('hex');
}

/** Issue a signed session token for a project. */
export function issueToken(projectId) {
  const payload = { p: String(projectId), e: Date.now() + getOwnerConfig().ttlMs };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `v1.${b64}.${sign(b64)}`;
}

/** Verify a signed session token: signature, project match and expiry. */
export function verifyOwnerToken(projectId, token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const expected = Buffer.from(sign(parts[1]));
  const given = Buffer.from(parts[2]);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (String(payload.p) !== String(projectId)) return false;
    if (!payload.e || Date.now() > payload.e) return false;
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------ lock state (persisted) ----------------------------- */

async function getAuthState(projectId) {
  const rows = await query('ownerAuth', r => String(r.project_id) === String(projectId));
  if (rows.length) return rows[0];
  return { failures: 0, locked_until: 0 };
}

async function setAuthState(projectId, patch) {
  const rows = await query('ownerAuth', r => String(r.project_id) === String(projectId));
  if (rows.length) {
    await update('ownerAuth', rows[0].id, patch);
  } else {
    await insert('ownerAuth', { project_id: String(projectId), ...patch });
  }
}

/** Current lock status for a project. */
export async function getLockInfo(projectId) {
  const state = await getAuthState(projectId);
  const now = Date.now();
  const lockedUntil = state.locked_until && state.locked_until > now ? state.locked_until : 0;
  return {
    locked: lockedUntil > 0,
    lockedUntil,
    remainingLockMs: lockedUntil > 0 ? lockedUntil - now : 0
  };
}

/**
 * Verify the owner password for a project.
 * Returns { ok, token?, remainingAttempts?, locked?, lockedUntil?, remainingLockMs?, message? }.
 */
export async function verifyOwnerPassword(projectId, password) {
  const cfg = getOwnerConfig();
  const state = await getAuthState(projectId);
  const now = Date.now();

  // While locked, reject even a correct password until the lock expires.
  if (state.locked_until && state.locked_until > now) {
    return {
      ok: false,
      error: 'OWNER_AUTH_LOCKED',
      message: `操作密码验证失败次数过多，已临时锁定，请在 ${Math.ceil((state.locked_until - now) / 60000)} 分钟后重试`,
      locked: true,
      lockedUntil: state.locked_until,
      remainingLockMs: state.locked_until - now
    };
  }

  const input = typeof password === 'string' ? password : '';
  if (safeEqual(input, cfg.password)) {
    await setAuthState(projectId, { failures: 0, locked_until: 0 });
    return { ok: true, token: issueToken(projectId), expiresIn: cfg.ttlMs, expiresAt: now + cfg.ttlMs };
  }

  const failures = (state.failures || 0) + 1;
  if (failures >= cfg.maxAttempts) {
    const lockedUntil = now + cfg.lockMs;
    await setAuthState(projectId, { failures: 0, locked_until: lockedUntil });
    return {
      ok: false,
      error: 'OWNER_AUTH_LOCKED',
      message: `操作密码错误，连续失败 ${cfg.maxAttempts} 次，已临时锁定 ${Math.ceil(cfg.lockMs / 60000)} 分钟`,
      remainingAttempts: 0,
      locked: true,
      lockedUntil,
      remainingLockMs: cfg.lockMs
    };
  }

  await setAuthState(projectId, { failures, locked_until: 0 });
  return {
    ok: false,
    error: 'OWNER_AUTH_INVALID',
    message: '操作密码错误',
    remainingAttempts: cfg.maxAttempts - failures,
    locked: false
  };
}

/* --------------------------------- middleware --------------------------------- */

/** Resolve the project id from the request (supports /:id and /plans/:planId...). */
export async function resolveProjectId(req) {
  if (req.params.id) return req.params.id;
  if (req.params.planId) {
    const plan = await getById('plans', req.params.planId);
    return plan ? plan.project_id : null;
  }
  if (req.params.changeId) {
    const change = await getById('planChanges', req.params.changeId);
    return change ? change.project_id : null;
  }
  return null;
}

/**
 * Express middleware: gate owner operations behind password verification.
 * Responds 401 with a structured body the frontend uses to open the password
 * dialog (or show the lockout countdown).
 */
export async function requireOwnerAuth(req, res, next) {
  try {
    // Role scoping: only the owner role is gated. A future role system can
    // send X-Role: reviewer (or any non-owner role) to bypass this check and
    // keep its original permission behavior.
    const role = req.headers['x-role'];
    if (role && String(role).toLowerCase() !== 'owner') return next();

    const projectId = await resolveProjectId(req);
    if (!projectId) return res.status(404).json({ error: 'Project not found' });

    const token = req.headers['x-owner-token'];
    if (token && verifyOwnerToken(projectId, token)) return next();

    const lock = await getLockInfo(projectId);
    if (lock.locked) {
      return res.status(401).json({
        error: 'OWNER_AUTH_LOCKED',
        message: '操作密码验证失败次数过多，已临时锁定',
        lock: { locked: true, lockedUntil: lock.lockedUntil, remainingLockMs: lock.remainingLockMs }
      });
    }
    return res.status(401).json({
      error: 'OWNER_AUTH_REQUIRED',
      message: '此操作需要验证原型 owner 操作密码',
      lock: { locked: false }
    });
  } catch (err) {
    next(err);
  }
}
