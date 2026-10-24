import type { Request, Response, NextFunction } from 'express';
import { clock } from '../clock.js';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Small in-memory fixed-window limiter. Adequate for a single-node prototype;
 * a shared store (e.g. Redis) is required for multi-node deployments.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private windowMs: number,
    private max: number,
  ) {}

  hit(key: string): { allowed: boolean; retryAfterSec: number } {
    const now = clock.nowMs();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    if (this.buckets.size > 10_000) this.prune(now);
    return { allowed: b.count <= this.max, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
  }

  reset(key?: string): void {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }

  private prune(now: number): void {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }

  middleware(keyFn: (req: Request) => string, message?: string) {
    return (req: Request, res: Response, next: NextFunction) => {
      const r = this.hit(keyFn(req));
      if (!r.allowed) {
        res.setHeader('Retry-After', String(r.retryAfterSec));
        res.status(429).json({ error: { code: 'RATE_LIMITED', message: message ?? 'Too many requests. Please wait and try again.' } });
        return;
      }
      next();
    };
  }
}
