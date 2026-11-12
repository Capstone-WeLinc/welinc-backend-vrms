import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

// Suite spec 0013, AC-30: permission changes left this feed; their history is in the portal
export const CHANGE_KINDS = ['all', 'setting', 'lookup'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

// Spec 0012, API surface: GET /vrms/settings/changes

const KEY_PATTERN = /^[a-z0-9_.]{1,60}$/;
const MAX_KEYS = 50;

/** The distinct keys of a `keys` string, in order (AC-31). Throws nothing; see keysProblem. */
export function parseKeys(keys: string): string[] {
  return [...new Set(keys.split(','))];
}

/** Why a `keys` string breaks AC-31, or null when it is valid. No trimming: split on commas. */
export function keysProblem(keys: string): string | null {
  const pieces = keys.split(',');
  if (pieces.some((k) => k === '')) {
    return 'keys must not hold an empty key (no empty value, double comma or trailing comma)';
  }
  if (pieces.some((k) => !KEY_PATTERN.test(k))) {
    return 'each key must be 1 to 60 characters of a to z, 0 to 9, _ and .';
  }
  if (parseKeys(keys).length > MAX_KEYS) {
    return `keys takes at most ${MAX_KEYS} distinct keys`;
  }
  return null;
}

@ValidatorConstraint({ name: 'changeKeys', async: false })
class ChangeKeysConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return typeof value === 'string' && keysProblem(value) === null;
  }
  defaultMessage(args?: { value?: unknown }) {
    return typeof args?.value === 'string'
      ? (keysProblem(args.value) ?? 'keys is not valid')
      : 'keys must be one comma separated string';
  }
}

export class ListChangesQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsIn(CHANGE_KINDS)
  kind?: ChangeKind;

  /** One comma separated string; keys given twice arrives as an array and fails (AC-31). */
  @IsOptional()
  @Validate(ChangeKeysConstraint)
  keys?: string;
}
