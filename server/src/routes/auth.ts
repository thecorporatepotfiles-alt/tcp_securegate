import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DB } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import { clock, addMinutes } from '../clock.js';
import { DUMMY_PASSWORD_HASH, hashPassword, sha256, verifyPassword } from '../lib/crypto.js';
import { parse } from '../lib/http.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';
import { buildActor, createSession, revokeSessionToken, revokeUserSessions, SESSION_COOKIE } from '../auth/sessions.js';
import { writeAudit } from '../services/audit.js';
import { PASSWORD_RULE } from '../services/admin.js';
import { getSettings } from '../services/settings.js';
import { ROLE_INFO, type RoleCode, DEMO_BANNER_TEXT } from '../../../shared/constants.js';
import type { AuthedRequest } from './middleware.js';
import { ctxOf, requireAuth } from './middleware.js';

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

export function authRoutes(db: DB, config: AppConfig, loginLimiter: RateLimiter): Router {
  const r = Router();

  const cookieOpts = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.secureCookies,
    path: '/',
    maxAge: config.sessionAbsoluteHours * 3_600_000,
  };

  function startSession(req: Request, res: Response, user: Record<string, any>, action: string) {
    const token = createSession(db, config, user.id, req.ip ?? null, req.get('user-agent') ?? null);
    db.prepare('UPDATE users SET last_login_at = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?').run(clock.nowIso(), user.id);
    const actor = buildActor(db, user as never, null);
    writeAudit(db, actor, { action, entityType: 'user', entityId: user.id, entityRef: user.username }, req.ip ?? null);
    res.cookie(SESSION_COOKIE, token, cookieOpts);
  }

  r.get('/config', (_req, res) => {
    const demo = config.mode === 'demo';
    const demoAccounts = demo
      ? (db
          .prepare(
            `SELECT u.username, u.display_name AS displayName, u.role_code AS role, u.designation, l.name AS locationName
             FROM users u LEFT JOIN locations l ON l.id = u.primary_location_id WHERE u.is_demo = 1 AND u.is_active = 1
             ORDER BY CASE u.role_code WHEN 'SYSTEM_ADMIN' THEN 0 WHEN 'HQ_ADMIN' THEN 1 WHEN 'LOCATION_ADMIN' THEN 2 WHEN 'HOST' THEN 3 WHEN 'GUARD' THEN 4 ELSE 5 END, u.username`,
          )
          .all() as { role: RoleCode }[]).map((a) => ({ ...a, roleName: ROLE_INFO[a.role].name }))
      : [];
    res.json({
      appName: 'TCP SecureGate',
      mode: config.mode,
      demo,
      demoBanner: demo ? DEMO_BANNER_TEXT : null,
      timezone: config.timezone,
      sessionIdleMinutes: config.sessionIdleMinutes,
      demoAccounts,
    });
  });

  r.post('/auth/login', loginLimiter.middleware((req) => `login:${req.ip}`, 'Too many sign-in attempts. Please wait a few minutes.'), (req, res) => {
    const { username, password } = parse(z.object({ username: z.string().trim().min(1).max(60), password: z.string().min(1).max(200) }), req.body);
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Record<string, any> | undefined;
    const ok = verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
    const now = clock.now();
    if (!user || !ok || user.is_active !== 1 || (user.locked_until && new Date(user.locked_until) > now)) {
      if (user && !ok) {
        const failed = (user.failed_login_count as number) + 1;
        db.prepare('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?').run(
          failed,
          failed >= MAX_FAILED ? addMinutes(now, LOCK_MINUTES) : user.locked_until,
          user.id,
        );
      }
      writeAudit(db, null, { action: 'auth.login', outcome: 'FAILURE', entityType: 'user', entityRef: username.slice(0, 60), metadata: { reason: !user ? 'unknown_user' : !ok ? 'bad_password' : user.is_active !== 1 ? 'disabled' : 'locked' } }, req.ip ?? null, user?.organization_id);
      const locked = user && user.locked_until && new Date(user.locked_until) > now;
      throw unauthorized(locked ? 'Account temporarily locked after repeated failed sign-ins.' : 'Invalid username or password.', 'INVALID_CREDENTIALS');
    }
    startSession(req, res, user, 'auth.login');
    res.json({ ok: true });
  });

  r.post('/auth/demo-login', loginLimiter.middleware((req) => `demo:${req.ip}`), (req, res) => {
    if (config.mode !== 'demo') throw notFound('Endpoint');
    const { username } = parse(z.object({ username: z.string().trim().min(1).max(60) }), req.body);
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_demo = 1 AND is_active = 1').get(username) as Record<string, any> | undefined;
    if (!user) throw unauthorized('Unknown demo account.', 'INVALID_CREDENTIALS');
    startSession(req, res, user, 'auth.demo_login');
    res.json({ ok: true });
  });

  r.post('/auth/logout', (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      const session = db.prepare('SELECT s.user_id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(
        sha256(token),
      ) as { user_id: number; username: string } | undefined;
      revokeSessionToken(db, token);
      if (session) writeAudit(db, null, { action: 'auth.logout', entityType: 'user', entityId: session.user_id, entityRef: session.username }, req.ip ?? null);
    }
    res.clearCookie(SESSION_COOKIE, { ...cookieOpts, maxAge: undefined });
    res.json({ ok: true });
  });

  r.get('/auth/me', requireAuth(db, config), (req, res) => {
    const ctx = ctxOf(req as AuthedRequest, db, config);
    const a = ctx.actor;
    const user = db.prepare('SELECT designation, department, is_demo FROM users WHERE id = ?').get(a.userId) as Record<string, any>;
    const settings = getSettings(db, a.orgId);
    const locations = db
      .prepare(`SELECT id, code, name, kind FROM locations WHERE id IN (${a.locationIds.map(() => '?').join(',') || 'NULL'}) ORDER BY CASE kind WHEN 'HQ' THEN 0 ELSE 1 END, name`)
      .all(...a.locationIds) as { id: number }[];
    const gates = db
      .prepare(`SELECT id, location_id AS locationId, code, name, gate_type AS gateType FROM gates WHERE is_active = 1 AND location_id IN (${a.locationIds.map(() => '?').join(',') || 'NULL'}) ORDER BY name`)
      .all(...a.locationIds) as { locationId: number }[];
    res.json({
      user: {
        id: a.userId,
        username: a.username,
        displayName: a.displayName,
        role: a.role,
        roleName: a.role ? ROLE_INFO[a.role].name : null,
        designation: user.designation,
        department: user.department,
        isDemo: user.is_demo === 1,
        allLocations: a.allLocations,
        primaryLocationId: a.primaryLocationId,
        assignedGateId: a.assignedGateId,
      },
      permissions: [...a.permissions],
      locations: locations.map((l) => ({ ...l, gates: gates.filter((g) => g.locationId === l.id) })),
      options: {
        vehicleCategories: settings['vehicle.categories'],
        deliveryCategories: settings['delivery.categories'],
        visitTransitions: settings['visit.transitions'],
        requireSecurityCheck: settings['visit.requireSecurityCheck'],
        manualReviewEligible: settings['gate.manualReviewEligible'],
        verificationTtlSeconds: settings['gate.verificationTtlSeconds'],
      },
      session: { idleMinutes: config.sessionIdleMinutes },
    });
  });

  r.post('/auth/change-password', requireAuth(db, config), (req, res) => {
    const ctx = ctxOf(req as AuthedRequest, db, config);
    const { currentPassword, newPassword } = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: PASSWORD_RULE }), req.body);
    const user = db.prepare('SELECT password_hash, is_demo FROM users WHERE id = ?').get(ctx.actor.userId) as { password_hash: string; is_demo: number };
    if (user.is_demo === 1 && config.mode === 'demo') throw forbidden('Demo account passwords cannot be changed.');
    if (!verifyPassword(currentPassword, user.password_hash)) throw unauthorized('Current password is incorrect.', 'INVALID_CREDENTIALS');
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(hashPassword(newPassword), clock.nowIso(), ctx.actor.userId);
      revokeUserSessions(db, ctx.actor.userId!);
      writeAudit(db, ctx.actor, { action: 'auth.password.change', entityType: 'user', entityId: ctx.actor.userId }, req.ip ?? null);
    })();
    res.clearCookie(SESSION_COOKIE, { ...cookieOpts, maxAge: undefined });
    res.json({ ok: true, reloginRequired: true });
  });

  return r;
}
