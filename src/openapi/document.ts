import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/** `info.version`: the repo's package.json, read from the working directory (the repo root, /app hosted). */
function packageVersion(): string {
  const raw = readFileSync(resolve('package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

/**
 * The five security schemes of VRMS spec 0026, AC-8, named the same in welinc-auth's copy; routes
 * name them through `decorators.ts`. backend-vrms declares only the two it accepts.
 */
export const SECURITY = {
  userToken: 'userToken',
  serviceToken: 'serviceToken',
  ssoCookie: 'ssoCookie',
  vrmsSession: 'vrmsSession',
  clientAssertion: 'clientAssertion',
} as const;

const DESCRIPTION = [
  'The VRMS API: repair tickets, issues and checklists, vehicles, the knowledge base, attachments,',
  'analytics, AI diagnosis and settings. Every API route takes a VRMS user access token; the',
  "`/vrms/session` routes are the web app's login and refresh, with the `vrms_rt` cookie.",
  '',
  'These docs are generated from the code and show the shapes of each route. Sign in and tokens',
  "are welinc-auth's: see its docs at `/auth/docs` and",
  '[contract 0001](https://github.com/Capstone-WeLinc/welinc-workspace/blob/main/docs/specs/_root/0001-shared-services-contract/index.md).',
].join('\n');

/** Sorts an object's keys, so two builds of the same code write the same bytes (AC-9). */
function sortKeys<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')),
  ) as T;
}

/** The OpenAPI document for the app, in a stable order (spec 0026, `src/openapi/document.ts`). */
export function buildDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('VRMS API')
    .setVersion(packageVersion())
    .setDescription(DESCRIPTION)
    .addServer('/')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'A VRMS user access token (`aud: VRMS`, `token_use: user`), from `/vrms/session/refresh`.',
      },
      SECURITY.userToken,
    )
    .addCookieAuth(
      'vrms_rt',
      {
        type: 'apiKey',
        in: 'cookie',
        description:
          "The VRMS web session's refresh cookie (`__Secure-vrms_rt` when hosted), on `/vrms/session`.",
      },
      SECURITY.vrmsSession,
    )
    .build();

  const doc = SwaggerModule.createDocument(app, config);
  doc.paths = sortKeys(doc.paths);
  for (const path of Object.keys(doc.paths)) {
    doc.paths[path] = sortKeys(doc.paths[path]);
  }
  doc.tags = [...(doc.tags ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  );
  if (doc.components?.schemas) {
    doc.components.schemas = sortKeys(doc.components.schemas);
  }
  return doc;
}
