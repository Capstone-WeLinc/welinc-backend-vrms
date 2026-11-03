import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_ROLES,
  type AuditAction,
  type AuditCategory,
  type AuditRoleFilter,
} from '../audit-events';

/**
 * Spec 0021, AC-10: a comma list (or a repeated parameter) as a list. Items are trimmed, empty
 * ones dropped and duplicates removed; values stay exact and case sensitive.
 */
function commaList({ value }: { value: unknown }): string[] | undefined {
  if (value == null) return undefined;
  const raw = (Array.isArray(value) ? value : [value]).flatMap((v) =>
    String(v).split(','),
  );
  return [...new Set(raw.map((v) => v.trim()).filter(Boolean))];
}

export class AuditEventsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  // Opaque position from the previous page's nextCursor
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  // The old single type filter, merged into `types` (spec 0021, AC-10)
  @IsOptional()
  @IsIn(AUDIT_ACTIONS, {
    message: `type must be one of the event types: ${AUDIT_ACTIONS.join(', ')}`,
  })
  type?: AuditAction;

  // Spec 0021, AC-9 and AC-10
  @IsOptional()
  @Transform(commaList)
  @ArrayMaxSize(AUDIT_CATEGORIES.length, {
    message: `categories accepts at most ${AUDIT_CATEGORIES.length} values`,
  })
  @IsIn(AUDIT_CATEGORIES, {
    each: true,
    message: `categories must be one of: ${AUDIT_CATEGORIES.join(', ')}`,
  })
  categories?: AuditCategory[];

  @IsOptional()
  @Transform(commaList)
  @ArrayMaxSize(30, { message: 'types accepts at most 30 values' })
  @IsIn(AUDIT_ACTIONS, {
    each: true,
    message: `types must be one of the event types: ${AUDIT_ACTIONS.join(', ')}`,
  })
  types?: AuditAction[];

  @IsOptional()
  @IsIn(AUDIT_ROLES, {
    message: `actorRole must be one of: ${AUDIT_ROLES.join(', ')}`,
  })
  actorRole?: AuditRoleFilter;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  // On created_at: `from` inclusive, `to` exclusive
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  repairNumber?: string;

  // One ticket's events, for the detail page's Activity section
  @IsOptional()
  @IsUUID()
  ticketId?: string;
}
