import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * VRMS spec 0026, AC-6: checks a reply body against the route's success schema in the committed
 * `docs/openapi.json`, so a response class that drifts from what the controller really sends
 * fails `npm test`. Used only by the controller reply tests.
 *
 * The rule: arrays are checked through `items`; a `required` field must be present; an optional
 * field may be missing; a reply field the schema does not name fails; a plain `object` property
 * (no `properties`) is not looked into; `null` passes only when the field is `nullable`; a
 * `oneOf` passes when one branch matches. Two levels: level 1 is the reply's own fields, level 2
 * the fields of the objects inside them (array items included); deeper is not checked.
 */

interface Schema {
  $ref?: string;
  allOf?: Schema[];
  oneOf?: Schema[];
  type?: string;
  nullable?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
}

interface Document {
  paths: Record<
    string,
    Record<
      string,
      {
        responses: Record<
          string,
          { content?: Record<string, { schema?: Schema }> }
        >;
      }
    >
  >;
  components?: { schemas?: Record<string, Schema> };
}

const MAX_DEPTH = 2;

let cached: Document | undefined;

function loadDocument(): Document {
  cached ??= JSON.parse(
    readFileSync(resolve(__dirname, '../../docs/openapi.json'), 'utf8'),
  ) as Document;
  return cached;
}

/** Follows `$ref`s and folds `allOf` into one schema (properties and required lists merged). */
function flatten(schema: Schema, doc: Document): Schema {
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const target = doc.components?.schemas?.[name];
    if (!target) throw new Error(`openapi.json has no schema ${name}`);
    return flatten(
      { ...target, nullable: schema.nullable || target.nullable },
      doc,
    );
  }
  if (!schema.allOf) return schema;
  const parts = schema.allOf.map((part) => flatten(part, doc));
  const merged: Schema = { nullable: schema.nullable };
  for (const part of [...parts, { ...schema, allOf: undefined }]) {
    merged.type ??= part.type;
    merged.items ??= part.items;
    merged.oneOf ??= part.oneOf;
    merged.nullable ||= part.nullable;
    if (part.properties)
      merged.properties = { ...merged.properties, ...part.properties };
    if (part.required)
      merged.required = [...(merged.required ?? []), ...part.required];
  }
  return merged;
}

/** Collects every place `value` breaks `schema`; `depth` counts the object levels entered. */
function check(
  value: unknown,
  raw: Schema,
  doc: Document,
  where: string,
  depth: number,
): string[] {
  const schema = flatten(raw, doc);
  if (value === null) {
    return schema.nullable ? [] : [`${where} is null but not nullable`];
  }
  if (schema.oneOf) {
    const results = schema.oneOf.map((branch) =>
      check(value, branch, doc, where, depth),
    );
    if (results.some((errors) => errors.length === 0)) return [];
    return [
      `${where} matches no oneOf branch: ${results.map((e) => e.join('; ')).join(' | ')}`,
    ];
  }

  const type = schema.type ?? (schema.properties ? 'object' : undefined);
  switch (type) {
    case undefined:
      return [];
    case 'string':
    case 'boolean':
      return typeof value === type
        ? []
        : [`${where} should be a ${type}, got ${typeof value}`];
    case 'number':
    case 'integer':
      return typeof value === 'number' &&
        (type === 'number' || Number.isInteger(value))
        ? []
        : [`${where} should be a ${type}, got ${JSON.stringify(value)}`];
    case 'array':
      if (!Array.isArray(value)) return [`${where} should be an array`];
      if (!schema.items) return [];
      return value.flatMap((item, i) =>
        check(item, schema.items!, doc, `${where}[${i}]`, depth),
      );
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return [`${where} should be an object`];
      }
      // A plain object (no properties) is not looked into, and nothing past level 2 is checked
      if (!schema.properties || depth >= MAX_DEPTH) return [];
      const body = value as Record<string, unknown>;
      const errors: string[] = [];
      for (const field of schema.required ?? []) {
        if (!(field in body)) errors.push(`${where}.${field} is missing`);
      }
      for (const [field, fieldValue] of Object.entries(body)) {
        const fieldSchema = schema.properties[field];
        if (!fieldSchema) {
          errors.push(`${where}.${field} is not in the schema`);
          continue;
        }
        errors.push(
          ...check(
            fieldValue,
            fieldSchema,
            doc,
            `${where}.${field}`,
            depth + 1,
          ),
        );
      }
      return errors;
    }
    default:
      return [];
  }
}

/** The success schema of `route` (`'GET /auth/systems'`, `{param}` paths) for `status`. */
function replySchema(doc: Document, route: string, status: number): Schema {
  const [method, path] = route.split(' ');
  const operation = doc.paths[path]?.[method.toLowerCase()];
  if (!operation) throw new Error(`openapi.json has no route ${route}`);
  const schema =
    operation.responses[String(status)]?.content?.['application/json']?.schema;
  if (!schema) {
    throw new Error(`openapi.json has no ${status} reply schema for ${route}`);
  }
  return schema;
}

/**
 * Throws, listing every mismatch, when `body` differs from the route's committed reply schema.
 * Regenerate the file with `npm run openapi` after changing a response class.
 */
export function expectReplyMatches(
  body: unknown,
  route: string,
  status: number,
): void {
  const doc = loadDocument();
  const errors = check(body, replySchema(doc, route, status), doc, 'reply', 0);
  if (errors.length) {
    throw new Error(
      `${route} ${status} reply differs from docs/openapi.json:\n  ${errors.join('\n  ')}`,
    );
  }
}
