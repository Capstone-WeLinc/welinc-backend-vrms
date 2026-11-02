import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { MechanicAssignmentDto, NewDriverDto } from './create-repair.dto';

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
