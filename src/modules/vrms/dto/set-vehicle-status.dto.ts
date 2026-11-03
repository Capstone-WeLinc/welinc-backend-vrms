import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsString, Length } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Spec 0020, AC-3: the only statuses an Admin may set. */
export const TOGGLE_STATUSES = ['AVAILABLE', 'DISABLED'] as const;
export type ToggleStatus = (typeof TOGGLE_STATUSES)[number];

// Spec 0020, AC-1 to AC-5: POST /vrms/vehicles/:id/status
export class SetVehicleStatusDto {
  @IsIn(TOGGLE_STATUSES, {
    message: 'Status must be AVAILABLE or DISABLED.',
  })
  status: ToggleStatus;

  // Trimmed first, so a blank reason fails the length check
  @Transform(trim)
  @IsString()
  @Length(5, 500, { message: 'Reason must be 5 to 500 characters.' })
  reason: string;

  // The row's updatedAt as loaded, for the stale check (AC-5)
  @IsISO8601()
  updatedAt: string;
}
