import { Transform } from 'class-transformer';
import { IsISO8601, IsString, Length, Matches } from 'class-validator';

// Spec 0030, AC-8, AC-9 and AC-15: the hand change and the reset. Both carry the stale check
// (lastUpdatedAt, as every spec 0019 edit) and a required reason.

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class DueDateReasonDto {
  @IsISO8601()
  lastUpdatedAt: string;

  @Transform(trim)
  @IsString()
  @Length(5, 500, { message: 'Say why, in 5 to 500 characters.' })
  reason: string;
}

/** PUT /vrms/repairs/:id/due-date */
export class ChangeDueDateDto extends DueDateReasonDto {
  // An offset is required, so the browser's timezone never guesses the moment
  @IsISO8601({ strict: true })
  @Matches(/(Z|[+-]\d{2}:?\d{2})$/, {
    message: 'dueAt needs a timezone offset, like 2026-12-01T09:00:00+08:00.',
  })
  dueAt: string;
}

/** POST /vrms/repairs/:id/due-date/automatic */
export class ResetDueDateDto extends DueDateReasonDto {}
