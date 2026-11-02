import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  MechanicAssignmentDto,
  NewDriverDto,
  RepairIssueDto,
} from './create-repair.dto';

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

/** PUT /vrms/repairs/:id/assignments: the full mechanic list, which may be empty (AC-9). */
export class SetMechanicsDto extends TicketEditDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MechanicAssignmentDto)
  mechanics: MechanicAssignmentDto[];
}

/** PATCH /vrms/repairs/:id/details. Omitted fields keep their value. */
export class EditTicketDetailsDto extends TicketEditDto {
  // AC-4: at most one of an existing driver or a new one by LTO license
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NewDriverDto)
  newDriver?: NewDriverDto;

  // AC-5: between the readings of the truck's tickets before and after this one
  @IsOptional()
  @IsInt({ message: 'Enter the odometer in whole kilometers.' })
  @Min(0)
  odometerReading?: number;

  @IsOptional()
  @IsBoolean()
  confirmOdometerJump?: boolean;

  @IsOptional()
  @IsEnum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

  // AC-7: CORPORATE needs an active corporation; ONLINE clears it
  @IsOptional()
  @IsEnum(['ONLINE', 'CORPORATE'], { message: 'Choose an account type.' })
  accountType?: 'ONLINE' | 'CORPORATE';

  @IsOptional()
  @IsUUID()
  corporationId?: string;
}

/** POST /vrms/repairs/:id/issues: create's issue fields and rules (AC-14). */
export class AddIssueDto extends RepairIssueDto {
  @IsISO8601()
  lastUpdatedAt: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** PATCH /vrms/repairs/:id/issues/:issueId: the system and the text after "[System] " (AC-15). */
export class EditIssueDto extends TicketEditDto {
  @IsUUID('all', { message: 'Choose a system.' })
  categoryId: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Describe the issue.' })
  @MaxLength(600)
  text: string;
}
