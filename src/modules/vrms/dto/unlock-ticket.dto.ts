import { IsISO8601, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UnlockTicketDto {
  @IsString()
  @IsNotEmpty({ message: 'An unlock reason is required' })
  @MaxLength(500)
  unlockReason: string;

  // Required, so an unlock runs the stale check (spec 0014, AC-12)
  @IsISO8601()
  lastUpdatedAt: string;
}
