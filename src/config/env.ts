import { z } from 'zod';

/**
 * Every environment variable backend-vrms reads at runtime, checked once at boot (spec 0010).
 * Nothing else in `src/` reads `process.env`: inject `ConfigService<Env, true>` instead.
 * `validateEnv` is pure: no logging, no side effects.
 */

// Empty or blank strings count as missing: .env.example ships some names empty.
const blank = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;
const required = z.preprocess(blank, z.string({ error: 'is required' }).trim());
const optional = <T extends z.ZodType>(s: T) =>
  z.preprocess(blank, s.optional());
const httpUrl = z.url({
  protocol: /^https?$/,
  error: 'must be an http or https URL',
});
/** "is required" first, then "must be a URL". */
const url = required.pipe(httpUrl);
const whole = (min: number, max: number, fallback: number) => {
  const error = `must be a whole number from ${min} to ${max}`;
  return z.preprocess(
    blank,
    z.coerce
      .number({ error })
      .int({ error })
      .min(min, { error })
      .max(max, { error })
      .default(fallback),
  );
};
const flag = z
  .preprocess(
    blank,
    z
      .enum(['true', 'false'], { error: 'must be true or false' })
      .default('false'),
  )
  .transform((v) => v === 'true');
/** "a, b," → ['a', 'b']; each entry must be a bare origin (no path, no trailing slash). */
const originList = required.transform((v, ctx) => {
  const items = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const item of items) {
    if (!isOrigin(item)) {
      ctx.addIssue({
        code: 'custom',
        message: 'each entry must be an origin like https://host',
      });
    }
  }
  return items;
});

function isOrigin(value: string): boolean {
  return URL.canParse(value) && new URL(value).origin === value;
}

export const envSchema = z.object({
  NODE_ENV: z.preprocess(
    blank,
    z
      .enum(['development', 'production', 'test'], {
        error: 'must be development, production or test',
      })
      .default('development'),
  ),
  PORT: whole(1, 65535, 3000),
  /** Proxy hops in front of backend-vrms: 1 locally (nginx), 2 hosted. */
  TRUST_PROXY_HOPS: whole(0, 10, 0),
  CORS_ORIGINS: originList,
  DATABASE_URL: required,

  // Token check (spec 0002)
  AUTH_ISSUER: required,
  AUTH_CLIENT_ID: required,
  AUTH_JWKS_URL: url,
  /** Container to container, so exempt from the production https rule. */
  AUTH_INTERNAL_URL: url,
  /** Parsed and self tested by `assertion-signer.ts` at boot (AC-13). */
  AUTH_CLIENT_PRIVATE_KEY: required,

  // Sessions (spec 0003)
  WEB_APP_URL: url,
  API_PUBLIC_URL: url,
  PORTAL_URL: url,
  AUTH_PUBLIC_URL: url,
  SESSION_COOKIE_SECURE: flag,

  // AI (spec 0013): optional in every mode
  GEMINI_API_KEY: optional(z.string().trim()),
  GEMINI_MODEL: z.preprocess(
    blank,
    z.string().trim().default('gemini-3.5-flash-lite'),
  ),
  GEMINI_EMBED_MODEL: z.preprocess(
    blank,
    z.string().trim().default('gemini-embedding-2'),
  ),

  // File storage (spec 0017): one of the first two is required in production
  STORAGE_CONNECTION_STRING: optional(z.string().trim()),
  STORAGE_ACCOUNT_URL: optional(httpUrl),
  STORAGE_CONTAINER: z.preprocess(
    blank,
    z.string().trim().default('vrms-attachments'),
  ),
  /** Exempt from the production rule while Azurite serves it locally. */
  STORAGE_PUBLIC_URL: optional(httpUrl),
});

export type Env = z.infer<typeof envSchema>;

/** URL variables held to https and no localhost in production (AC-4). */
const PRODUCTION_URLS = [
  'AUTH_JWKS_URL',
  'WEB_APP_URL',
  'API_PUBLIC_URL',
  'PORTAL_URL',
  'AUTH_PUBLIC_URL',
  'STORAGE_ACCOUNT_URL',
] as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Why `value` can't be used in production, or null. Unparseable values are left to the field rules. */
function productionUrlProblem(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') return 'must use https in production';
  if (LOCAL_HOSTS.has(parsed.hostname)) {
    return 'must not point at localhost in production';
  }
  return null;
}

const text = (
  raw: Record<string, unknown>,
  name: string,
): string | undefined => {
  const value = blank(raw[name]);
  return typeof value === 'string' ? value.trim() : undefined;
};

/** Production rules, checked on the blank normalised raw values so they run even when a field failed. */
function productionIssues(raw: Record<string, unknown>): string[] {
  if (text(raw, 'NODE_ENV') !== 'production') return [];
  const lines: string[] = [];

  // AC-3
  if (
    !text(raw, 'STORAGE_CONNECTION_STRING') &&
    !text(raw, 'STORAGE_ACCOUNT_URL')
  ) {
    lines.push(
      'STORAGE_CONNECTION_STRING or STORAGE_ACCOUNT_URL: one is required in production',
    );
  }
  if (text(raw, 'SESSION_COOKIE_SECURE') !== 'true') {
    lines.push('SESSION_COOKIE_SECURE: must be true in production');
  }
  const hops = text(raw, 'TRUST_PROXY_HOPS');
  if (hops === undefined || Number(hops) === 0) {
    lines.push('TRUST_PROXY_HOPS: must be at least 1 in production');
  }

  // AC-4
  for (const name of PRODUCTION_URLS) {
    const value = text(raw, name);
    const problem = value === undefined ? null : productionUrlProblem(value);
    if (problem) lines.push(`${name}: ${problem}`);
  }
  const origins = text(raw, 'CORS_ORIGINS')?.split(',') ?? [];
  for (const origin of origins.map((o) => o.trim()).filter(Boolean)) {
    const problem = productionUrlProblem(origin);
    if (problem) {
      lines.push(`CORS_ORIGINS: each entry ${problem}`);
      break;
    }
  }
  return lines;
}

/** ConfigModule's validate hook. Throws one Error listing every problem; never includes a value. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  const lines = [
    ...(result.success
      ? []
      : result.error.issues.map((i) => `${String(i.path[0])}: ${i.message}`)),
    ...productionIssues(raw),
  ];
  if (lines.length) {
    const unique = [...new Set(lines)];
    throw new Error(`Environment check failed:\n  ${unique.join('\n  ')}`);
  }
  return result.data!;
}

/** The AC-5 warnings, logged by bootstrap() once the app's logger is set. */
export function envWarnings(
  get: <K extends keyof Env>(key: K) => Env[K],
): string[] {
  const lines: string[] = [];
  if (!get('GEMINI_API_KEY')) {
    lines.push(
      'AI is off: GEMINI_API_KEY is not set, so AI diagnosis answers 503 and embedding is skipped',
    );
  }
  const connection = get('STORAGE_CONNECTION_STRING');
  const account = get('STORAGE_ACCOUNT_URL');
  if (!connection && !account) {
    lines.push(
      'File storage is off: set STORAGE_CONNECTION_STRING or STORAGE_ACCOUNT_URL; attachment routes answer 503 STORAGE_UNAVAILABLE',
    );
  } else if (connection && account) {
    lines.push(
      'Both STORAGE_CONNECTION_STRING and STORAGE_ACCOUNT_URL are set: using the connection string, STORAGE_ACCOUNT_URL is ignored',
    );
  }
  return lines;
}

/**
 * Valid values for tests (no secrets, no network): loaded by Jest setupFiles (AC-9). The client
 * key is the published ES256 example key from RFC 7515 appendix A.3; nothing trusts it.
 */
export const testEnv: Record<string, string> = {
  NODE_ENV: 'test',
  CORS_ORIGINS: 'http://localhost:8000,http://localhost:8001',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  AUTH_ISSUER: 'http://localhost:3000/auth',
  AUTH_CLIENT_ID: 'vrms',
  AUTH_JWKS_URL: 'http://auth-service:3001/auth/.well-known/jwks.json',
  AUTH_INTERNAL_URL: 'http://auth-service:3001',
  AUTH_CLIENT_PRIVATE_KEY: JSON.stringify({
    kty: 'EC',
    crv: 'P-256',
    kid: 'test-only',
    alg: 'ES256',
    x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
    y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
    d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
  }),
  WEB_APP_URL: 'http://localhost:8001',
  API_PUBLIC_URL: 'http://localhost:3000',
  PORTAL_URL: 'http://localhost:8000',
  AUTH_PUBLIC_URL: 'http://localhost:3000/auth',
};
