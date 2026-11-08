import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

/**
 * Proxy hops in front of backend-vrms (spec 0003): 1 locally (nginx), 2 hosted. `req.ip` is then
 * the user's address, which VRMS forwards to welinc-auth as `X-WeLinc-User-Address`. Unset
 * trusts none, so a forged X-Forwarded-For is ignored.
 */
function trustProxyHops(): number {
  const raw = process.env['TRUST_PROXY_HOPS'];
  if (raw === undefined || raw === '') return 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error('TRUST_PROXY_HOPS must be a whole number, 0 or more');
  }
  return hops;
}

function isLocalDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', trustProxyHops());
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

  const corsOrigins = process.env['CORS_ORIGINS']
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (corsOrigins && corsOrigins.length > 0) {
        if (corsOrigins.includes('*')) {
          callback(null, true);
          return;
        }
        callback(
          null,
          corsOrigins.includes(origin) || isLocalDevOrigin(origin),
        );
        return;
      }

      callback(null, isLocalDevOrigin(origin));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
  });
  await app.listen(process.env['PORT'] ?? 3000);
}
void bootstrap();
