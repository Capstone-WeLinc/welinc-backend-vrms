import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { apiReference } from '@scalar/nestjs-api-reference';
import type { Request, Response } from 'express';
import { existsSync } from 'fs';
import { join, sep } from 'path';
import { apiDocsEnabled, type Env } from '../config/env';
import { buildDocument } from './document';

/** The route prefix every docs path sits under, the same one the gateway routes on. */
const PREFIX = '/vrms/docs';

/**
 * Scalar's single file browser bundle, served from node_modules so the page loads nothing from
 * outside (AC-3). The package doesn't export this path, so it is found from the package's main entry.
 */
function scalarBundlePath(): string | null {
  try {
    const main = require.resolve('@scalar/api-reference');
    const root = main.slice(0, main.lastIndexOf(`${sep}dist${sep}`));
    const path = join(root, 'dist', 'browser', 'standalone.js');
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/**
 * VRMS spec 0026: serves the Scalar page, the OpenAPI document and the Scalar bundle, when
 * `API_DOCS_ENABLED` is on (AC-1). Off, nothing is mounted and the paths answer the usual 404 (AC-2).
 * Mounted on Express before `listen`, outside the controllers, so global guards don't run here and
 * the docs routes never appear in the document.
 */
export function mountDocs(
  app: NestExpressApplication,
  config: ConfigService<Env, true>,
): void {
  if (!apiDocsEnabled((key) => config.get(key, { infer: true }))) return;

  const log = new Logger('ApiDocs');
  const bundle = scalarBundlePath();
  if (!bundle) {
    log.error(
      'API docs are off: the Scalar bundle @scalar/api-reference/dist/browser/standalone.js is missing',
    );
    return;
  }

  const document = buildDocument(app);
  const express = app.getHttpAdapter().getInstance() as {
    get: (path: string, handler: (req: Request, res: Response) => void) => void;
  };

  express.get(`${PREFIX}/openapi.json`, (_req, res) => {
    res.json(document);
  });
  express.get(`${PREFIX}/scalar.js`, (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('application/javascript').sendFile(bundle);
  });
  express.get(
    PREFIX,
    apiReference({
      pageTitle: 'VRMS API',
      url: `${PREFIX}/openapi.json`,
      cdn: `${PREFIX}/scalar.js`,
      withDefaultFonts: false,
      persistAuth: false,
      authentication: { preferredSecurityScheme: 'userToken' },
    }) as (req: Request, res: Response) => void,
  );
  log.log(`API docs at ${PREFIX}`);
}
