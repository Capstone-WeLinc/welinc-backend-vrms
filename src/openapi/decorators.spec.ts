import { Controller, Get, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ApiOperation } from '@nestjs/swagger';
import {
  ApiCookieRoute,
  ApiErrorMap,
  ApiErrors,
  ApiGenericErrors,
  ApiHtmlError,
  ApiNoErrors,
  ApiUserToken,
  ApiVrmsSession,
} from './decorators';
import { buildDocument, SECURITY } from './document';

// covers: VRMS spec 0026 AC-4 (error replies), AC-8 (security schemes, cookie route line), AC-9 (stable order).
// The decorators run on small throwaway controllers; the document is read back the way Scalar reads it.

@ApiGenericErrors()
@Controller('generic')
class GenericController {
  @Get('plain')
  plain() {
    return 'ok';
  }

  @Get('own')
  @ApiErrors(409, ['CONFLICT'])
  own() {
    return 'ok';
  }

  @Get('page')
  @ApiHtmlError(500, 'An error page')
  page() {
    return 'ok';
  }

  @Get('silent')
  @ApiNoErrors()
  silent() {
    return 'ok';
  }
}

@Controller('errors')
class ErrorsController {
  @Get('always')
  @ApiErrors(403, ['CSRF_REJECTED', 'RATE_LIMITED'])
  always() {
    return 'ok';
  }

  @Get('sometimes')
  @ApiErrors(400, ['VALIDATION_FAILED', null])
  sometimes() {
    return 'ok';
  }

  @Get('none')
  @ApiErrors(400, [null])
  none() {
    return 'ok';
  }

  @Post('oauth')
  @ApiErrors(400, ['invalid_grant', 'invalid_request'])
  oauth() {
    return 'ok';
  }

  @Post('both')
  @ApiErrors(400, ['VALIDATION_FAILED', 'invalid_grant'])
  both() {
    return 'ok';
  }

  @Get('mapped')
  @ApiErrorMap(
    { 401: ['TOKEN_EXPIRED'], 403: ['RATE_LIMITED', 'CSRF_REJECTED'] },
    { 403: ['CSRF_REJECTED', 'ACCOUNT_LOCKED'], 404: ['NOT_FOUND', null] },
  )
  mapped() {
    return 'ok';
  }
}

@Controller('security')
class SecurityController {
  @Get('token')
  @ApiUserToken()
  token() {
    return 'ok';
  }

  @Post('cookie')
  @ApiVrmsSession()
  @ApiOperation({ summary: 'Refresh the session' })
  @ApiCookieRoute()
  cookie() {
    return 'ok';
  }

  @Get('open')
  open() {
    return 'ok';
  }
}

type Operation = {
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  responses: Record<
    string,
    {
      description: string;
      content?: Record<string, { schema: Record<string, unknown> }>;
    }
  >;
};

let app: INestApplication;
let doc: OpenAPIObject;

const op = (path: string, method = 'get'): Operation =>
  (doc.paths[path] as Record<string, Operation>)[method];

const schemaOf = (path: string, status: string, method = 'get') =>
  op(path, method).responses[status].content!['application/json'].schema;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [GenericController, ErrorsController, SecurityController],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  doc = buildDocument(app);
});

afterAll(async () => {
  await app.close();
});

describe('ApiErrors', () => {
  it('requires a code and names every value when the route always sends one', () => {
    const route = op('/errors/always');
    expect(route.responses['403'].description).toBe(
      '`CSRF_REJECTED` or `RATE_LIMITED`',
    );
    const schema = schemaOf('/errors/always', '403') as {
      allOf: Record<string, unknown>[];
    };
    expect(schema.allOf[0]).toEqual({
      $ref: '#/components/schemas/CodedError',
    });
    expect(schema.allOf[1]).toEqual({
      properties: {
        code: { type: 'string', enum: ['CSRF_REJECTED', 'RATE_LIMITED'] },
      },
      required: ['code'],
    });
  });

  it('does not require a code when the status can also come with none', () => {
    expect(op('/errors/sometimes').responses['400'].description).toBe(
      '`VALIDATION_FAILED` or no `code`',
    );
    const schema = schemaOf('/errors/sometimes', '400') as {
      allOf: Record<string, unknown>[];
    };
    expect(schema.allOf[1]).not.toHaveProperty('required');
  });

  it('points a status with only the null entry at the plain error shape', () => {
    expect(schemaOf('/errors/none', '400')).toEqual({
      $ref: '#/components/schemas/CodedError',
    });
    expect(op('/errors/none').responses['400'].description).toBe('no `code`');
  });

  it('uses the OAuth error shape for lower case values', () => {
    expect(op('/errors/oauth', 'post').responses['400'].description).toBe(
      'OAuth `invalid_grant` or `invalid_request`',
    );
    const schema = schemaOf('/errors/oauth', '400', 'post') as {
      allOf: Record<string, unknown>[];
    };
    expect(schema.allOf[0]).toEqual({
      $ref: '#/components/schemas/OAuthError',
    });
    expect(schema.allOf[1]).toEqual({
      properties: {
        error: { type: 'string', enum: ['invalid_grant', 'invalid_request'] },
      },
    });
  });

  it('writes a oneOf when both shapes answer the same status', () => {
    const route = op('/errors/both', 'post');
    expect(route.responses['400'].description).toBe(
      '`VALIDATION_FAILED`; OAuth `invalid_grant`',
    );
    const schema = schemaOf('/errors/both', '400', 'post') as {
      oneOf: unknown[];
    };
    expect(schema.oneOf).toHaveLength(2);
  });

  it('registers both error classes as components', () => {
    expect(Object.keys(doc.components!.schemas!)).toEqual(
      expect.arrayContaining(['CodedError', 'OAuthError']),
    );
  });
});

describe('ApiErrorMap', () => {
  it('merges the maps per status without repeating a code', () => {
    const route = op('/errors/mapped');
    expect(route.responses['403'].description).toBe(
      '`ACCOUNT_LOCKED`, `CSRF_REJECTED` or `RATE_LIMITED`',
    );
  });

  it('writes one response per status, in status order', () => {
    expect(
      Object.keys(op('/errors/mapped').responses).filter((s) => s !== '200'),
    ).toEqual(['401', '403', '404']);
  });

  it('keeps the no code entry after the sorted named codes', () => {
    expect(op('/errors/mapped').responses['404'].description).toBe(
      '`NOT_FOUND` or no `code`',
    );
  });
});

describe('ApiGenericErrors', () => {
  it('gives a route with no errors of its own the 400, 401 and 403 set', () => {
    const statuses = Object.keys(op('/generic/plain').responses);
    expect(statuses).toEqual(expect.arrayContaining(['400', '401', '403']));
  });

  it('leaves a route that declares its own errors alone', () => {
    const statuses = Object.keys(op('/generic/own').responses);
    expect(statuses).toContain('409');
    expect(statuses).not.toContain('401');
    expect(statuses).not.toContain('403');
  });

  it('leaves a route marked as answering an HTML error page alone', () => {
    const route = op('/generic/page');
    expect(Object.keys(route.responses)).not.toContain('401');
    expect(route.responses['500'].content).toHaveProperty('text/html');
  });

  it('leaves a route marked as answering no JSON error alone', () => {
    const statuses = Object.keys(op('/generic/silent').responses);
    expect(statuses).not.toContain('400');
    expect(statuses).not.toContain('401');
  });
});

describe('security schemes and the cookie route line', () => {
  it('names the user token scheme on a bearer route', () => {
    expect(op('/security/token').security).toEqual([{ userToken: [] }]);
  });

  it('names the vrmsSession scheme on a cookie route', () => {
    expect(op('/security/cookie', 'post').security).toEqual([
      { vrmsSession: [] },
    ]);
  });

  it('declares only the two schemes backend-vrms accepts', () => {
    expect(Object.keys(doc.components!.securitySchemes!).sort()).toEqual([
      SECURITY.userToken,
      SECURITY.vrmsSession,
    ]);
  });

  it('adds the Origin check line to a cookie route and keeps its summary', () => {
    const route = op('/security/cookie', 'post');
    expect(route.summary).toBe('Refresh the session');
    expect(route.description).toContain('CSRF_REJECTED');
    expect(route.description).toContain('docs page');
  });

  it('carries no security on a route that names none', () => {
    expect(op('/security/open').security).toBeUndefined();
  });
});

describe('buildDocument', () => {
  it('sorts paths and the methods under each path', () => {
    const paths = Object.keys(doc.paths);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('sorts the component schemas', () => {
    const names = Object.keys(doc.components!.schemas!);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('builds the same bytes twice from the same code', () => {
    expect(JSON.stringify(buildDocument(app))).toBe(JSON.stringify(doc));
  });

  it('takes the version from package.json and serves from the root', () => {
    const pkg = readFileSync(resolve('package.json'), 'utf8');
    expect(doc.info.version).toBe(
      (JSON.parse(pkg) as { version: string }).version,
    );
    expect(doc.info.title).toBe('VRMS API');
    expect(doc.servers?.map((server) => server.url)).toEqual(['/']);
  });
});
