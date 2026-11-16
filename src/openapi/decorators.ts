import { applyDecorators } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiResponse,
  ApiSecurity,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { SECURITY } from './document';
import { CodedError, OAuthError } from './schemas';

/**
 * VRMS spec 0026 decorators: the security scheme a route accepts (AC-8) and its error replies
 * (AC-4). Several scheme decorators on one route mean any one of them is accepted.
 */

/** A user access token as `Authorization: Bearer`. */
export const ApiUserToken = () => ApiBearerAuth(SECURITY.userToken);

/** A client credentials service token as `Authorization: Bearer`. */
export const ApiServiceToken = () => ApiBearerAuth(SECURITY.serviceToken);

/** welinc-auth's SSO cookie (the portal routes; welinc-auth only, kept so both copies match). */
export const ApiSsoCookie = () => ApiCookieAuth(SECURITY.ssoCookie);

/** The `vrms_rt` cookie on `/vrms/session`. */
export const ApiVrmsSession = () => ApiCookieAuth(SECURITY.vrmsSession);

/** A `private_key_jwt` client assertion in the form body of `/auth/token`. */
export const ApiClientAssertion = () => ApiSecurity(SECURITY.clientAssertion);

/** `API_OPERATION` in @nestjs/swagger (its constants file is not exported). */
const API_OPERATION = 'swagger/apiOperation';

const COOKIE_ROUTE_NOTE =
  'Called by a web app with its cookie. A request sent from this docs page is refused by the ' +
  'Origin check (403 `CSRF_REJECTED`), so try it from the VRMS web app instead.';

/** The AC-8 line on every cookie route: the docs page can't call it. */
export const ApiCookieRoute = (): MethodDecorator => (_target, _key, d) => {
  // Merges only the description: ApiOperation would reset the summary the plugin reads from comments
  const previous = (Reflect.getMetadata(API_OPERATION, d.value!) ??
    {}) as Record<string, unknown>;
  Reflect.defineMetadata(
    API_OPERATION,
    { ...previous, description: COOKIE_ROUTE_NOTE },
    d.value!,
  );
  return d;
};

/** `API_RESPONSE` in @nestjs/swagger: the responses map stored on a route method. */
const API_RESPONSE = 'swagger/apiResponse';

/** A list of codes as the response description: `A`, `B`, or no `code`. */
function describeCodes(codes: readonly (string | null)[], field: string) {
  const named = codes.filter((c): c is string => c !== null);
  const parts = named.map((c) => `\`${c}\``);
  if (named.length < codes.length) parts.push(`no \`${field}\``);
  return parts.length > 1
    ? `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`
    : (parts[0] ?? '');
}

/**
 * One error status with the values the route really answers (AC-4; the code wins over contract
 * 0001). An UPPER_CASE value is a `code` of the coded shape; a lower_case value is an OAuth
 * `error` (RFC 6749, `/auth/token` and the client assertion forms); `null` means the status
 * also comes with no `code`. When both shapes share a status the schema is a `oneOf`.
 */
export function ApiErrors(status: number, values: readonly (string | null)[]) {
  const oauth = values.filter(
    (v): v is string => v !== null && v === v.toLowerCase(),
  );
  const codes = values.filter((v) => v === null || v !== v.toLowerCase());
  const named = codes.filter((c): c is string => c !== null);
  const always = named.length === codes.length && named.length > 0;

  const coded = named.length
    ? {
        allOf: [
          { $ref: getSchemaPath(CodedError) },
          {
            properties: { code: { type: 'string', enum: named } },
            ...(always ? { required: ['code'] } : {}),
          },
        ],
      }
    : { $ref: getSchemaPath(CodedError) };
  const oauthShape = {
    allOf: [
      { $ref: getSchemaPath(OAuthError) },
      { properties: { error: { type: 'string', enum: oauth } } },
    ],
  };
  const schema = !oauth.length
    ? coded
    : !codes.length
      ? oauthShape
      : { oneOf: [coded, oauthShape] };

  const description = [
    codes.length ? describeCodes(codes, 'code') : '',
    oauth.length ? `OAuth ${describeCodes(oauth, 'error')}` : '',
  ]
    .filter(Boolean)
    .join('; ');

  return applyDecorators(
    ApiExtraModels(CodedError, OAuthError),
    ApiResponse({ status, description, schema }),
  );
}

/** Marks a route that answers no JSON error, so `ApiGenericErrors()` leaves it alone. */
const NO_ERRORS = 'welinc/apiNoErrors';
export const ApiNoErrors = (): MethodDecorator => (_target, _key, d) => {
  Reflect.defineMetadata(NO_ERRORS, true, d.value!);
  return d;
};

/** A route that answers an HTML error page (the browser routes), not JSON. */
export function ApiHtmlError(status: number, description: string) {
  return applyDecorators(
    ApiNoErrors(),
    ApiResponse({
      status,
      description,
      content: { 'text/html': { schema: { type: 'string' } } },
    }),
  );
}

const GENERIC_ERRORS = [
  ApiBadRequestResponse({
    description: 'The input failed validation',
    type: CodedError,
  }),
  ApiUnauthorizedResponse({
    description: 'No valid credentials',
    type: CodedError,
  }),
  ApiForbiddenResponse({
    description: 'Not allowed for this caller',
    type: CodedError,
  }),
];

/** Does this route method already declare an error reply (status 400 or more)? */
function declaresErrors(method: object): boolean {
  const responses = (Reflect.getMetadata(API_RESPONSE, method) ?? {}) as Record<
    string,
    unknown
  >;
  return Object.keys(responses).some((status) => Number(status) >= 400);
}

/**
 * The generic 400, 401 and 403 set (AC-4), on each route of the controller that declares no
 * errors of its own. A class level ApiResponse would merge into every route, adding statuses a
 * contract route never answers, so this applies the set route by route instead.
 */
export const ApiGenericErrors = (): ClassDecorator => (target) => {
  const proto = target.prototype as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    const method = descriptor?.value as object | undefined;
    if (
      typeof method !== 'function' ||
      !Reflect.hasMetadata(PATH_METADATA, method)
    )
      continue;
    if (declaresErrors(method) || Reflect.getMetadata(NO_ERRORS, method))
      continue;
    for (const decorate of GENERIC_ERRORS) decorate(proto, key, descriptor!);
  }
};

/** Error codes per status; `null` means the status also comes with no `code`. */
export type ErrorMap = Partial<Record<number, readonly (string | null)[]>>;

/**
 * Every error reply of a route (AC-4) from one or more maps, merged per status: usually the
 * guard sets from `guard-errors.ts` plus the route's own codes. One `ApiErrors` per status.
 */
export function ApiErrorMap(...maps: ErrorMap[]) {
  const merged = new Map<number, (string | null)[]>();
  for (const map of maps) {
    for (const [status, codes] of Object.entries(map)) {
      const list = merged.get(Number(status)) ?? [];
      for (const code of codes ?? []) if (!list.includes(code)) list.push(code);
      merged.set(Number(status), list);
    }
  }
  return applyDecorators(
    ...[...merged.entries()]
      .sort(([a], [b]) => a - b)
      .map(([status, codes]) =>
        // Named codes sorted, so the order in the file never depends on the map order
        ApiErrors(status, [
          ...codes.filter((c): c is string => c !== null).sort(),
          ...codes.filter((c) => c === null),
        ]),
      ),
  );
}
