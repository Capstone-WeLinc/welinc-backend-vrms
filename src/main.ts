// VRMS spec 0025: Sentry must start before Nest and Express load, so this stays the first import
import './instrument';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { envWarnings, type Env } from './config/env';
import { mountDocs } from './openapi/docs';

function isLocalDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // Spec 0010, AC-5: the environment the app runs in, and each optional service that is off
  const envLog = new Logger('Env');
  envLog.log(`Environment: ${config.get('NODE_ENV', { infer: true })}`);
  envWarnings((key) => config.get(key, { infer: true })).forEach((line) =>
    envLog.warn(line),
  );

  // Proxy hops in front of backend-vrms (spec 0003): 1 locally (nginx), 2 hosted. `req.ip` is then
  // the user's address, which VRMS forwards to welinc-auth as `X-WeLinc-User-Address`. 0 trusts
  // none, so a forged X-Forwarded-For is ignored.
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));
  // The vrms_rt refresh cookie and the login state cookie (spec 0003, AC-16)
  app.use(cookieParser());

  // Spec 0017, AC-1: no files on local disk; attachments open through signed Blob Storage links
  app.use((_: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()',
    );
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );

  // Browser origins allowed besides local development ones (each a bare origin, spec 0010)
  const corsOrigins = config.get('CORS_ORIGINS', { infer: true });

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, corsOrigins.includes(origin) || isLocalDevOrigin(origin));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // sentry-trace and baggage link a browser crash to the API error behind it (spec 0025, AC-9)
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'sentry-trace',
      'baggage',
    ],
    credentials: true,
  });
  // VRMS spec 0026: /vrms/docs, on locally and on staging, never in production
  mountDocs(app, config);
  await app.listen(config.get('PORT', { infer: true }));
}
void bootstrap();

const unusedVerifyVariable = 1;
