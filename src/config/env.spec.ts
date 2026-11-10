import { readFileSync } from 'fs';
import { join } from 'path';
import { envSchema, envWarnings, testEnv, validateEnv, type Env } from './env';

// covers: spec 0010 AC-1 to AC-6, AC-10

const errorOf = (raw: Record<string, unknown>): string => {
  try {
    validateEnv(raw);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the environment check to fail');
};

/** A full production set that passes every rule. */
const PRODUCTION: Record<string, string> = {
  ...testEnv,
  NODE_ENV: 'production',
  TRUST_PROXY_HOPS: '2',
  SESSION_COOKIE_SECURE: 'true',
  CORS_ORIGINS: 'https://portal.welinc.test,https://vrms.welinc.test',
  AUTH_JWKS_URL: 'https://api.welinc.test/auth/.well-known/jwks.json',
  WEB_APP_URL: 'https://vrms.welinc.test',
  API_PUBLIC_URL: 'https://api.welinc.test',
  PORTAL_URL: 'https://portal.welinc.test',
  AUTH_PUBLIC_URL: 'https://api.welinc.test/auth',
  STORAGE_ACCOUNT_URL: 'https://acct.blob.core.windows.net',
};

describe('validateEnv', () => {
  it('passes a full valid set and fills the documented defaults (AC-6)', () => {
    const env = validateEnv(testEnv);
    expect(env).toMatchObject({
      NODE_ENV: 'test',
      PORT: 3000,
      TRUST_PROXY_HOPS: 0,
      SESSION_COOKIE_SECURE: false,
      GEMINI_MODEL: 'gemini-3.5-flash-lite',
      GEMINI_EMBED_MODEL: 'gemini-embedding-2',
      STORAGE_CONTAINER: 'vrms-attachments',
      CORS_ORIGINS: ['http://localhost:8000', 'http://localhost:8001'],
    });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.STORAGE_CONNECTION_STRING).toBeUndefined();
  });

  it('defaults NODE_ENV to development', () => {
    const { NODE_ENV: _, ...rest } = testEnv;
    expect(validateEnv(rest).NODE_ENV).toBe('development');
  });

  it('passes a full production set', () => {
    expect(validateEnv(PRODUCTION).NODE_ENV).toBe('production');
  });

  it('lists every missing or blank required name at once, one line each (AC-1)', () => {
    const message = errorOf({
      ...testEnv,
      AUTH_ISSUER: '',
      DATABASE_URL: '   ',
      WEB_APP_URL: undefined,
    });
    expect(message).toContain('Environment check failed:');
    expect(message).toContain('AUTH_ISSUER: is required');
    expect(message).toContain('DATABASE_URL: is required');
    expect(message).toContain('WEB_APP_URL: is required');
  });

  it.each([
    ['PORTAL_URL', 'ftp://portal.test', 'must be an http or https URL'],
    ['PORTAL_URL', 'not a url', 'must be an http or https URL'],
    ['PORT', '99999', 'must be a whole number from 1 to 65535'],
    ['PORT', '30.5', 'must be a whole number from 1 to 65535'],
    ['TRUST_PROXY_HOPS', 'two', 'must be a whole number from 0 to 10'],
    ['SESSION_COOKIE_SECURE', 'yes', 'must be true or false'],
    ['NODE_ENV', 'staging', 'must be development, production or test'],
    [
      'CORS_ORIGINS',
      'https://a.test/',
      'each entry must be an origin like https://host',
    ],
    [
      'CORS_ORIGINS',
      'https://a.test,https://b.test/app',
      'each entry must be an origin like https://host',
    ],
    ['STORAGE_ACCOUNT_URL', 'acct.blob', 'must be an http or https URL'],
  ])('refuses %s=%s with a named reason (AC-2)', (name, value, reason) => {
    expect(errorOf({ ...testEnv, [name]: value })).toContain(
      `${name}: ${reason}`,
    );
  });

  it('accepts a comma list of origins with spaces and a trailing comma', () => {
    const env = validateEnv({
      ...testEnv,
      CORS_ORIGINS: ' https://a.test , https://b.test:8443, ',
    });
    expect(env.CORS_ORIGINS).toEqual(['https://a.test', 'https://b.test:8443']);
  });

  describe('in production', () => {
    it('lists a bad URL and missing storage together with field problems (AC-1, AC-3)', () => {
      const message = errorOf({
        ...PRODUCTION,
        PORTAL_URL: 'http://portal.welinc.test',
        STORAGE_ACCOUNT_URL: '',
        AUTH_ISSUER: '',
      });
      expect(message).toContain('AUTH_ISSUER: is required');
      expect(message).toContain('PORTAL_URL: must use https in production');
      expect(message).toContain(
        'STORAGE_CONNECTION_STRING or STORAGE_ACCOUNT_URL: one is required in production',
      );
    });

    it('accepts the connection string alone for storage', () => {
      expect(() =>
        validateEnv({
          ...PRODUCTION,
          STORAGE_ACCOUNT_URL: '',
          STORAGE_CONNECTION_STRING: 'AccountName=a;AccountKey=b',
        }),
      ).not.toThrow();
    });

    it.each([
      ['SESSION_COOKIE_SECURE', 'false', 'must be true in production'],
      ['SESSION_COOKIE_SECURE', '', 'must be true in production'],
      ['TRUST_PROXY_HOPS', '0', 'must be at least 1 in production'],
      ['TRUST_PROXY_HOPS', '', 'must be at least 1 in production'],
    ])('refuses %s=%j (AC-3)', (name, value, reason) => {
      expect(errorOf({ ...PRODUCTION, [name]: value })).toContain(
        `${name}: ${reason}`,
      );
    });

    it.each([
      ['WEB_APP_URL', 'https://localhost:8001'],
      ['API_PUBLIC_URL', 'https://127.0.0.1'],
      ['AUTH_PUBLIC_URL', 'https://[::1]/auth'],
      ['AUTH_JWKS_URL', 'https://localhost/jwks.json'],
    ])('refuses %s pointing at the local machine (AC-4)', (name, value) => {
      expect(errorOf({ ...PRODUCTION, [name]: value })).toContain(
        `${name}: must not point at localhost in production`,
      );
    });

    it('refuses an http or localhost CORS entry (AC-4)', () => {
      expect(
        errorOf({
          ...PRODUCTION,
          CORS_ORIGINS: 'https://ok.test,http://localhost:8001',
        }),
      ).toContain('CORS_ORIGINS: each entry must use https in production');
    });

    it('lets the container to container and Azurite addresses stay local', () => {
      expect(() =>
        validateEnv({
          ...PRODUCTION,
          AUTH_INTERNAL_URL: 'http://auth-service:3001',
          STORAGE_PUBLIC_URL: 'http://localhost:10000/devstoreaccount1',
        }),
      ).not.toThrow();
    });

    it('leaves development free of the production rules', () => {
      expect(() =>
        validateEnv({ ...testEnv, NODE_ENV: 'development' }),
      ).not.toThrow();
    });
  });

  it('never puts a secret value in the message, whatever fails (AC-1)', () => {
    const SENTINEL = 'SENTINEL-9f2c';
    const secrets = {
      DATABASE_URL: `postgresql://u:${SENTINEL}@db/x`,
      AUTH_CLIENT_PRIVATE_KEY: SENTINEL,
      GEMINI_API_KEY: SENTINEL,
      STORAGE_CONNECTION_STRING: `AccountKey=${SENTINEL}`,
    };
    const failures: Record<string, string>[] = [
      { ...testEnv, ...secrets, PORT: SENTINEL },
      { ...testEnv, ...secrets, PORTAL_URL: SENTINEL },
      { ...testEnv, ...secrets, CORS_ORIGINS: `https://${SENTINEL}.test/` },
      { ...testEnv, ...secrets, SESSION_COOKIE_SECURE: SENTINEL },
      { ...PRODUCTION, ...secrets, WEB_APP_URL: `http://${SENTINEL}.test` },
      { ...PRODUCTION, ...secrets, TRUST_PROXY_HOPS: '0', AUTH_ISSUER: '' },
    ];
    for (const raw of failures) {
      expect(errorOf(raw)).not.toContain(SENTINEL);
    }
  });
});

describe('envWarnings (AC-5)', () => {
  const warnings = (extra: Record<string, string>) => {
    const env = validateEnv({ ...testEnv, ...extra });
    return envWarnings(<K extends keyof Env>(key: K) => env[key]);
  };

  it('warns once each when the AI and storage are off', () => {
    const lines = warnings({});
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^AI is off: GEMINI_API_KEY/);
    expect(lines[1]).toMatch(/^File storage is off/);
  });

  it('says nothing when both are set up', () => {
    expect(
      warnings({
        GEMINI_API_KEY: 'k',
        STORAGE_CONNECTION_STRING: 'AccountName=a;AccountKey=b',
      }),
    ).toEqual([]);
  });

  it('names the ignored account URL when both storage settings are set', () => {
    const lines = warnings({
      GEMINI_API_KEY: 'k',
      STORAGE_CONNECTION_STRING: 'AccountName=a;AccountKey=b',
      STORAGE_ACCOUNT_URL: 'https://acct.blob.core.windows.net',
    });
    expect(lines).toEqual([
      expect.stringContaining('STORAGE_ACCOUNT_URL is ignored'),
    ]);
  });
});

describe('.env.example and the schema stay in step (AC-10)', () => {
  /** Names only scripts, compose or the platform read. */
  const SKIP_NAMES = new Set(['TZ', 'NODE_OPTIONS']);
  const SKIP_PREFIXES = ['AZURE_', 'POSTGRES_', 'PRISMA_'];
  const skipped = (name: string) =>
    SKIP_NAMES.has(name) || SKIP_PREFIXES.some((p) => name.startsWith(p));

  /** Lines like `NAME=` or `# NAME=`: commented names count as documented. */
  const exampleNames = readFileSync(
    join(__dirname, '..', '..', '.env.example'),
    'utf8',
  )
    .split(/\r?\n/)
    .map((line) => /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name) && !skipped(name!));
  const schemaNames = Object.keys(envSchema.shape);

  it('documents every schema name in .env.example', () => {
    expect(schemaNames.filter((n) => !exampleNames.includes(n))).toEqual([]);
  });

  it('has every .env.example name in the schema', () => {
    expect(exampleNames.filter((n) => !schemaNames.includes(n))).toEqual([]);
  });

  it('gives testEnv every required name', () => {
    expect(() => validateEnv(testEnv)).not.toThrow();
  });
});
