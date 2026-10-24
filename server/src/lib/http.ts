import { z } from 'zod';
import type { Request } from 'express';
import { badRequest } from './errors.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest(fields[0]?.path ? `${fields[0].path}: ${fields[0].message}` : 'Invalid request', { fields });
  }
  return result.data;
}

export function idParam(req: Request, name = 'id'): number {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${name}`);
  return n;
}

// Reusable field schemas -----------------------------------------------------

export const zText = (max = 200) => z.string().trim().min(1, 'Required').max(max);
export const zOptText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const zOptDate = zDate.optional().nullable().or(z.literal('').transform(() => null));
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
export const zIso = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Expected a date-time');
export const zId = z.coerce.number().int().positive();
export const zOptId = z.coerce.number().int().positive().optional().nullable();
export const zPhone = z
  .string()
  .trim()
  .max(20)
  .regex(/^[+0-9 ()-]*$/, 'Digits, spaces, +, - and brackets only')
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));
export const zEmail = z
  .string()
  .trim()
  .max(120)
  .optional()
  .nullable()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Invalid email address');

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(100).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  locationId: zId.optional(),
});
export type ListQuery = z.infer<typeof listQuery>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Map a requested sort key to a whitelisted SQL expression. */
export function orderBy(
  sort: string | undefined,
  dir: 'asc' | 'desc' | undefined,
  allowed: Record<string, string>,
  fallback: string,
): string {
  const expr = sort && allowed[sort] ? allowed[sort] : fallback;
  const direction = dir === 'asc' ? 'ASC' : dir === 'desc' ? 'DESC' : '';
  return direction ? `${expr} ${direction}` : expr;
}

export function likeParam(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}
