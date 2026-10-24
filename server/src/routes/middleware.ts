import type { NextFunction, Request, Response } from 'express';
import type { DB } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import type { Actor, Ctx } from '../auth/context.js';
import { resolveSession, SESSION_COOKIE } from '../auth/sessions.js';

export interface AuthedRequest extends Request {
  actor: Actor;
}

export function requireAuth(db: DB, config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = resolveSession(db, config, req.cookies?.[SESSION_COOKIE]);
    if (!result.ok) {
      const message =
        result.code === 'SESSION_EXPIRED'
          ? 'Your session has expired. Please sign in again.'
          : result.code === 'ACCOUNT_DISABLED'
            ? 'This account is disabled.'
            : 'Authentication required.';
      res.status(401).json({ error: { code: result.code, message } });
      return;
    }
    (req as AuthedRequest).actor = result.actor;
    next();
  };
}

export function ctxOf(req: AuthedRequest, db: DB, config: AppConfig): Ctx {
  return { db, config, actor: req.actor, ip: req.ip ?? null };
}

/**
 * State-changing requests must carry a custom header. Browsers cannot add it
 * cross-site without a CORS preflight (which this API never grants), so this
 * complements the SameSite=Strict session cookie as CSRF protection.
 */
export function requireCsrfHeader(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-sg-request') !== '1') {
    res.status(403).json({ error: { code: 'CSRF', message: 'Missing request header' } });
    return;
  }
  next();
}
