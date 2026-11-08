import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  RequestMethod,
  Type,
} from '@nestjs/common';
import {
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import request from 'supertest';
import { AppModule } from '../../app.module';
import {
  SESSION_CONFIG,
  type SessionConfig,
} from '../../session/session.config';
import { TOKEN_VERIFIER } from '../verify';
import type { AuthUser } from '../account-check';
import { SystemType, UserRole } from '../roles';
import { MATRIX_ROLES, PermissionKey } from './catalog';
import {
  AUTHENTICATED_KEY,
  PERMISSION_KEY,
  PUBLIC_KEY,
} from './permission.decorators';
import { defaultKeys, FakePermissions } from './permissions.fake';
import { PermissionsGuard } from './permissions.guard';
import { PermissionsService } from './permissions.service';

// Spec 0011, AC-7 and AC-15. Routes are read from the module tree, so a new route or key is
// covered without writing a new test.

type Route = {
  controller: Type;
  handler: string;
  method: string;
  path: string;
  keys?: PermissionKey[];
  authenticated: boolean;
  isPublic: boolean;
};

const HTTP_METHODS: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

function controllersOf(module: unknown, seen = new Set<unknown>()): Type[] {
  // A dynamic module is an object carrying its class under `module`
  const target =
    module && typeof module === 'object' && 'module' in module
      ? module.module
      : module;
  if (!target || seen.has(target)) return [];
  seen.add(target);
  const own = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, target) ??
    []) as Type[];
  const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, target) ??
    []) as unknown[];
  return [...own, ...imports.flatMap((m) => controllersOf(m, seen))];
}

function joinPath(base: string, path: string) {
  const parts = [base, path].filter((p) => p && p !== '/');
  return `/${parts.join('/')}`.replace(/\/+/g, '/');
}

function routesOf(controller: Type): Route[] {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).flatMap((handler) => {
    const fn = proto[handler];
    if (handler === 'constructor' || typeof fn !== 'function') return [];
    const path = Reflect.getMetadata(PATH_METADATA, fn) as string | undefined;
    if (path === undefined) return [];
    const meta = <T>(key: string) =>
      (Reflect.getMetadata(key, fn) ?? Reflect.getMetadata(key, controller)) as
        | T
        | undefined;
    return [
      {
        controller,
        handler,
        method:
          HTTP_METHODS[
            Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod
          ] ?? 'unknown',
        path: joinPath(base, path),
        keys: meta<PermissionKey[]>(PERMISSION_KEY),
        authenticated: meta<boolean>(AUTHENTICATED_KEY) === true,
        isPublic: meta<boolean>(PUBLIC_KEY) === true,
      },
    ];
  });
}

const controllers = controllersOf(AppModule);
const routes = controllers.flatMap(routesOf);
const label = (r: Route) => `${r.method.toUpperCase()} ${r.path}`;

describe('Route decorators (AC-7)', () => {
  it('finds the routes of every module', () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.map(label)).toEqual(
      expect.arrayContaining([
        'GET /',
        'GET /vrms/permissions/me',
        'GET /vrms/repairs',
        'GET /vrms/knowledge/entries',
        'GET /vrms/config/garages',
      ]),
    );
  });

  it('opens mechanics.view only on the two Team section reads, never a write (spec 0022, AC-3)', () => {
    expect(
      routes.filter((r) => r.keys?.includes('mechanics.view')).map(label),
    ).toEqual([
      'GET /vrms/mechanics/roster',
      'GET /vrms/mechanics/:authUserId/open-tickets',
    ]);
  });

  it('gives every route exactly one of RequirePermission, Authenticated or Public', () => {
    const wrong = routes.filter(
      (r) =>
        [!!r.keys?.length, r.authenticated, r.isPublic].filter(Boolean)
          .length !== 1,
    );
    expect(wrong.map(label)).toEqual([]);
  });

  it('opens only the health check and the login and refresh routes (spec 0003, AC-16) to everyone, and only /permissions/me, the attachment routes (spec 0017, AC-12; spec 0018, AC-9) and the session status to any signed in user', () => {
    expect(routes.filter((r) => r.isPublic).map(label)).toEqual([
      'GET /',
      'GET /vrms/session/start',
      'GET /vrms/session/callback',
      'POST /vrms/session/refresh',
    ]);
    expect(routes.filter((r) => r.authenticated).map(label)).toEqual([
      'GET /vrms/permissions/me',
      'GET /vrms/repairs/:id/attachments',
      'DELETE /vrms/repairs/:id/attachments/:attachmentId',
      'PATCH /vrms/repairs/:id/attachments/:attachmentId',
      'POST /vrms/repairs/:id/attachments',
      'GET /vrms/session/status',
    ]);
  });
});

/** Stands in for JwtAuthGuard: the caller's role comes from a test header. */
@Injectable()
class TestUserGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();
    const role = req.header('x-test-role');
    if (role) {
      req.user = {
        sub: '00000000-0000-4000-8000-0000000000f1',
        email: 'caller@welinc.com',
        name: 'Caller',
        system: SystemType.VRMS,
        roles: [{ role: role as UserRole, system: SystemType.VRMS }],
      };
    }
    return true;
  }
}

/** Every service method answers an empty object, so only the guards decide the status. */
const stubService = () =>
  new Proxy(
    {},
    {
      get: (_, prop) =>
        prop === 'then' ? undefined : () => Promise.resolve({}),
    },
  );

const UUID = '00000000-0000-4000-8000-0000000000e1';

const TEST_SESSION_CONFIG: SessionConfig = {
  webAppUrl: 'http://localhost:8001',
  webAppOrigin: 'http://localhost:8001',
  portalUrl: 'http://localhost:8000',
  authPublicUrl: 'http://localhost:3000/auth',
  redirectUri: 'http://localhost:3000/vrms/session/callback',
  cookieSecure: false,
  clientId: 'vrms',
  tokenUrl: 'http://auth-service:3001/auth/token',
};

describe('Every route against every matrix role, under the default matrix (AC-15)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const deps = new Set(
      controllers.flatMap(
        (c) => (Reflect.getMetadata('design:paramtypes', c) ?? []) as Type[],
      ),
    );
    deps.delete(PermissionsService);
    const moduleRef = await Test.createTestingModule({
      // The upload route's per user throttle guard needs its options (spec 0017, AC-12)
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10_000 }])],
      controllers,
      providers: [
        ...[...deps].map((dep) => ({ provide: dep, useValue: stubService() })),
        { provide: PermissionsService, useClass: FakePermissions },
        // The session routes (spec 0003) read their config and check the bearer themselves
        { provide: SESSION_CONFIG, useValue: TEST_SESSION_CONFIG },
        {
          provide: TOKEN_VERIFIER,
          useValue: {
            verify: () =>
              Promise.resolve({ tokenUse: 'user', sid: 's1', roles: [] }),
          },
        },
        { provide: APP_GUARD, useClass: TestUserGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(() => app.close());

  const cases = routes.flatMap((route) =>
    [...MATRIX_ROLES, UserRole.CUSTOMER_SUPPORT].map(
      (role) => [`${label(route)} as ${role}`, route, role] as const,
    ),
  );

  it.each(cases)('%s', async (_, route, role) => {
    const granted = defaultKeys([role]);
    const allowed =
      route.isPublic ||
      route.authenticated ||
      (route.keys ?? []).some((key) => granted.has(key));
    const path = route.path.replace(/:\w+/g, UUID);
    const res = await (
      request(
        app.getHttpServer() as Parameters<typeof request>[0],
      ) as unknown as Record<string, (path: string) => request.Test>
    )
      [route.method](path)
      .set('x-test-role', role)
      .set('authorization', 'Bearer test')
      // The session cookie routes' CSRF guard wants the VRMS origin (spec 0003, AC-17)
      .set('origin', TEST_SESSION_CONFIG.webAppOrigin)
      .send({});
    if (allowed) {
      expect(res.status).not.toBe(403);
    } else {
      expect(res.status).toBe(403);
    }
  });
});
