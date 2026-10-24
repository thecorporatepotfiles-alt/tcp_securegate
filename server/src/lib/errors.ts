export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required', code = 'UNAUTHENTICATED') =>
  new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string, code = 'CONFLICT', details?: unknown) =>
  new AppError(409, code, message, details);
export const unprocessable = (message: string, code = 'INVALID_STATE', details?: unknown) =>
  new AppError(422, code, message, details);
export const tooMany = (message = 'Too many requests. Please wait and try again.') =>
  new AppError(429, 'RATE_LIMITED', message);
