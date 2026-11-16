import { Controller, Get, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Env } from '../config/env';
import { mountDocs } from './docs';

// @scalar/nestjs-api-reference is ES module only and the Jest config doesn't transform it, so it is
// replaced by a stand in that records its options and answers a page naming the same URLs.
const apiReference = jest.fn((options: { url: string; cdn: string }) => {
  return (_req: unknown, res: { send: (html: string) => void }) =>
    res.send(
      `<html><title>VRMS API</title><script src="${options.cdn}"></script><div data-url="${options.url}"></div></html>`,
    );
});
jest.mock('@scalar/nestjs-api-reference', () => ({
  apiReference: (options: { url: string; cdn: string }) =>
    apiReference(options),
}));

// covers: VRMS spec 0026 AC-1 (docs served when on), AC-2 (404 when off), AC-3 (nothing from another origin), AC-7 (docs routes not in the document).

@Controller('ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

async function appWith(values: Partial<Record<keyof Env, unknown>>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [PingController],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  const config = {
    get: (key: keyof Env) => values[key],
  } as unknown as ConfigService<Env, true>;
  mountDocs(app, config);
  await app.init();
  return app;
}

const DOC_PATHS = [
  '/vrms/docs',
  '/vrms/docs/openapi.json',
  '/vrms/docs/scalar.js',
];

describe('mountDocs with the switch on', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    app = await appWith({ API_DOCS_ENABLED: true, NODE_ENV: 'development' });
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('serves the OpenAPI document as JSON that lists the real routes', async () => {
    const res = await request(app.getHttpServer())
      .get('/vrms/docs/openapi.json')
      .expect(200);
    expect(res.type).toBe('application/json');
    const body = res.body as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(body.openapi).toMatch(/^3\./);
    expect(Object.keys(body.paths)).toContain('/ping');
  });

  it('keeps the docs routes themselves out of the document', async () => {
    const res = await request(app.getHttpServer()).get(
      '/vrms/docs/openapi.json',
    );
    const body = res.body as { paths: Record<string, unknown> };
    for (const path of Object.keys(body.paths)) {
      expect(path.startsWith('/vrms/docs')).toBe(false);
    }
  });

  it('serves the Scalar bundle from the app with a cache header', async () => {
    const res = await request(app.getHttpServer())
      .get('/vrms/docs/scalar.js')
      .expect(200);
    expect(res.type).toBe('application/javascript');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.text.length).toBeGreaterThan(1000);
  });

  it('serves a docs page that loads the script and the document from the same origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/vrms/docs')
      .expect(200);
    expect(res.type).toBe('text/html');
    expect(res.text).toContain('VRMS API');
    expect(res.text).toContain('/vrms/docs/scalar.js');
    expect(res.text).toContain('/vrms/docs/openapi.json');
  });

  it('configures Scalar to load nothing from another origin and set no proxy', () => {
    const options = apiReference.mock.calls[0][0] as Record<string, unknown>;
    expect(options.cdn).toBe('/vrms/docs/scalar.js');
    expect(options.url).toBe('/vrms/docs/openapi.json');
    expect(options.withDefaultFonts).toBe(false);
    expect(options).not.toHaveProperty('proxyUrl');
    expect(options.persistAuth).toBe(false);
    expect(options.showDeveloperTools).toBe('never');
    expect(options.agent).toEqual({ disabled: true });
    expect(options.authentication).toEqual({
      preferredSecurityScheme: 'userToken',
    });
  });

  it('leaves the normal routes working', async () => {
    await request(app.getHttpServer()).get('/ping').expect(200, { ok: true });
  });
});

describe('mountDocs with the switch off', () => {
  it.each([
    [
      'API_DOCS_ENABLED is false',
      { API_DOCS_ENABLED: false, NODE_ENV: 'development' },
    ],
    ['unset in production', { NODE_ENV: 'production' }],
  ])(
    'answers the usual 404 on all three docs paths when %s',
    async (_name, values) => {
      const app = await appWith(values);
      try {
        for (const path of DOC_PATHS) {
          const res = await request(app.getHttpServer()).get(path);
          expect(res.status).toBe(404);
          expect((res.body as { message: string }).message).toContain(
            `Cannot GET ${path}`,
          );
        }
      } finally {
        await app.close();
      }
    },
  );

  it('serves the docs when unset outside production', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const app = await appWith({ NODE_ENV: 'development' });
    try {
      await request(app.getHttpServer())
        .get('/vrms/docs/openapi.json')
        .expect(200);
    } finally {
      await app.close();
      jest.restoreAllMocks();
    }
  });
});
