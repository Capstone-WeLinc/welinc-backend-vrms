import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';

// Spec 0019: the edit endpoints after create (details, mechanics, issues).

/** What every edit body carries: the stale check, and a reason on an unlocked closed ticket. */
export class TicketEditDto {
  // Required, so every edit runs the stale check (AC-18)
  @IsISO8601()
  lastUpdatedAt: string;

  // AC-3: required on an unlocked Closed or Cancelled ticket, 5 to 500 after trimming. The service
  // checks the length so the answer is its REASON_REQUIRED code
  @IsOptional()
  @IsString()
  reason?: string;
}

/** PATCH /vrms/repairs/:id/details. Omitted fields keep their value. */
export class EditTicketDetailsDto extends TicketEditDto {
  @IsOptional()
  @IsEnum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}
