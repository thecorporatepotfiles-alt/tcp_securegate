/**
 * helmet@8 stand-in for the browser edition (aliased as 'helmet').
 *
 * Responses never reach a browser's HTTP layer here, so these headers are
 * inert; the middleware still sets helmet's default header set (honouring the
 * options server/src/app.ts passes) so the API behaves the same in tests.
 */

type Directive = string[] | string | null | readonly string[];

export interface ContentSecurityPolicyOptions {
  useDefaults?: boolean;
  directives?: Record<string, Directive>;
  reportOnly?: boolean;
}

export interface HelmetOptions {
  contentSecurityPolicy?: ContentSecurityPolicyOptions | boolean;
  crossOriginEmbedderPolicy?: { policy?: string } | boolean;
  crossOriginOpenerPolicy?: { policy?: string } | boolean;
  crossOriginResourcePolicy?: { policy?: string } | boolean;
  originAgentCluster?: boolean;
  referrerPolicy?: { policy?: string | string[] } | boolean;
  strictTransportSecurity?: { maxAge?: number; includeSubDomains?: boolean; preload?: boolean } | boolean;
  xContentTypeOptions?: boolean;
  xDnsPrefetchControl?: { allow?: boolean } | boolean;
  xDownloadOptions?: boolean;
  xFrameOptions?: { action?: 'deny' | 'sameorigin' } | boolean;
  xPermittedCrossDomainPolicies?: { permittedPolicies?: string } | boolean;
  xPoweredBy?: boolean;
  xXssProtection?: boolean;
}

interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
  removeHeader(name: string): unknown;
}

export type HelmetMiddleware = (req: unknown, res: HeaderTarget, next: (err?: unknown) => void) => void;

const DEFAULT_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  'base-uri': ["'self'"],
  'font-src': ["'self'", 'https:', 'data:'],
  'form-action': ["'self'"],
  'frame-ancestors': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'object-src': ["'none'"],
  'script-src': ["'self'"],
  'script-src-attr': ["'none'"],
  'style-src': ["'self'", 'https:', "'unsafe-inline'"],
  'upgrade-insecure-requests': [],
};

const dashify = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Serialise CSP directives the way helmet does: `name value value;name2 ...`. */
function contentSecurityPolicy({ useDefaults = true, directives = {} }: ContentSecurityPolicyOptions): string {
  const result = new Map<string, readonly string[]>(useDefaults ? Object.entries(DEFAULT_DIRECTIVES) : []);
  for (const [rawName, value] of Object.entries(directives)) {
    const name = dashify(rawName);
    if (value === null) result.delete(name);
    else result.set(name, typeof value === 'string' ? [value] : value);
  }
  if (!result.has('default-src')) throw new Error('Content-Security-Policy needs a default-src but none was provided.');
  return [...result].map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name)).join(';');
}

const enabled = <T>(option: T | boolean | undefined): option is T | true | undefined => option !== false;
const opts = <T extends object>(option: T | boolean | undefined): Partial<T> => (typeof option === 'object' ? option : {});

export default function helmet(options: HelmetOptions = {}): HelmetMiddleware {
  const headers: [string, string][] = [];
  const csp = options.contentSecurityPolicy;
  if (enabled(csp)) {
    const cspOpts = opts(csp);
    headers.push([cspOpts.reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', contentSecurityPolicy(cspOpts)]);
  }
  if (options.crossOriginEmbedderPolicy) headers.push(['Cross-Origin-Embedder-Policy', opts(options.crossOriginEmbedderPolicy).policy ?? 'require-corp']);
  if (enabled(options.crossOriginOpenerPolicy)) headers.push(['Cross-Origin-Opener-Policy', opts(options.crossOriginOpenerPolicy).policy ?? 'same-origin']);
  if (enabled(options.crossOriginResourcePolicy)) headers.push(['Cross-Origin-Resource-Policy', opts(options.crossOriginResourcePolicy).policy ?? 'same-origin']);
  if (enabled(options.originAgentCluster)) headers.push(['Origin-Agent-Cluster', '?1']);
  if (enabled(options.referrerPolicy)) {
    const policy = opts(options.referrerPolicy).policy ?? 'no-referrer';
    headers.push(['Referrer-Policy', Array.isArray(policy) ? policy.join(',') : String(policy)]);
  }
  if (enabled(options.strictTransportSecurity)) {
    const hsts = opts(options.strictTransportSecurity);
    const parts = [`max-age=${Math.floor(hsts.maxAge ?? 365 * 24 * 60 * 60)}`];
    if (hsts.includeSubDomains !== false) parts.push('includeSubDomains');
    if (hsts.preload) parts.push('preload');
    headers.push(['Strict-Transport-Security', parts.join('; ')]);
  }
  if (enabled(options.xContentTypeOptions)) headers.push(['X-Content-Type-Options', 'nosniff']);
  if (enabled(options.xDnsPrefetchControl)) headers.push(['X-DNS-Prefetch-Control', opts(options.xDnsPrefetchControl).allow ? 'on' : 'off']);
  if (enabled(options.xDownloadOptions)) headers.push(['X-Download-Options', 'noopen']);
  if (enabled(options.xFrameOptions)) headers.push(['X-Frame-Options', (opts(options.xFrameOptions).action ?? 'sameorigin').toUpperCase()]);
  if (enabled(options.xPermittedCrossDomainPolicies)) {
    headers.push(['X-Permitted-Cross-Domain-Policies', opts(options.xPermittedCrossDomainPolicies).permittedPolicies ?? 'none']);
  }
  if (enabled(options.xXssProtection)) headers.push(['X-XSS-Protection', '0']);
  const removePoweredBy = enabled(options.xPoweredBy);

  return function helmetMiddleware(_req, res, next) {
    for (const [name, value] of headers) res.setHeader(name, value);
    if (removePoweredBy) res.removeHeader('X-Powered-By');
    next();
  };
}
