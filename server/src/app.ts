import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db/connection.js';
import type { AppConfig } from './config.js';
import { AppError } from './lib/errors.js';
import { RateLimiter } from './lib/rateLimit.js';
import { authRoutes } from './routes/auth.js';
import { apiRoutes } from './routes/api.js';
import { requireCsrfHeader, type AuthedRequest } from './routes/middleware.js';
import { writeAudit } from './services/audit.js';

export interface AppDeps {
  db: DB;
  config: AppConfig;
}

export function createApp({ db, config }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          mediaSrc: ["'self'", 'blob:'],
          workerSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(config.mode === 'production' ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      strictTransportSecurity: config.secureCookies ? { maxAge: 15552000, includeSubDomains: true } : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  const apiLimiter = new RateLimiter(60_000, 1200);
  const loginLimiter = new RateLimiter(5 * 60_000, 20);
  const gateLimiter = new RateLimiter(60_000, 120);
  app.locals.limiters = { apiLimiter, loginLimiter, gateLimiter };

  app.use('/api', apiLimiter.middleware((req) => `api:${req.ip}`));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', requireCsrfHeader);
  app.get('/api/health', (_req, res) => res.json({ ok: true, mode: config.mode, time: new Date().toISOString() }));
  app.use('/api', authRoutes(db, config, loginLimiter));
  app.use('/api', apiRoutes(db, config, gateLimiter));
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }));

  if (config.serveClient && fs.existsSync(path.join(config.clientDir, 'index.html'))) {
    app.use(express.static(config.clientDir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(config.clientDir, 'index.html')));
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const actor = (req as AuthedRequest).actor;
    if (err instanceof AppError) {
      if (err.status === 403 && actor) {
        try {
          writeAudit(db, actor, { action: 'access.denied', outcome: 'DENIED', metadata: { method: req.method, path: req.path.slice(0, 120), reason: err.message } }, req.ip ?? null);
        } catch {
          /* never fail the response because of audit logging */
        }
      }
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    const e = err as { type?: string; code?: string; message?: string; status?: number };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request body too large' } });
      return;
    }
    if (typeof e?.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) {
      res.status(409).json({ error: { code: 'CONSTRAINT', message: 'The change conflicts with existing records. Refresh and try again.' } });
      return;
    }
    if (e?.type === 'charset.unsupported' || e?.type === 'encoding.unsupported') {
      res.status(415).json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Request bodies must be UTF-8 JSON without a content encoding.' } });
      return;
    }
    // Other client errors raised below the routes: a malformed %-escape in the path or a body that
    // cannot be decoded (400), or a client file that cannot be served as asked (404, 412, 416).
    // Keep their status, but reply with a fixed message (theirs can echo raw request input) and do
    // not log them as server faults. The type is set explicitly because sendFile may already have
    // labelled the response as the file's.
    if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
      const error =
        e.status === 400
          ? { code: 'BAD_REQUEST', message: 'The request could not be understood.' }
          : e.status === 404
            ? { code: 'NOT_FOUND', message: 'Not found' }
            : { code: 'REQUEST_REJECTED', message: 'The request could not be completed.' };
      res.status(e.status).type('application/json').json({ error });
      return;
    }
    console.error('[api] unhandled error', err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'An unexpected error occurred.' } });
  });

  return app;
}
