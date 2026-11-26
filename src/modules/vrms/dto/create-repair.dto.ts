import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsArray,
  IsBoolean,
  ValidateNested,
  ValidateIf,
  IsEnum,
  IsUUID,
  Matches,
  MaxLength,
  ArrayMinSize,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const trimUpper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** An LTO driver's license number, such as A01-23-456789 (spec 0016, AC-6). */
export const LICENSE_PATTERN = /^[A-Z]\d{2}-\d{2}-\d{6}$/;

// In house mechanics only, by Mechanic id (spec 0010, AC-12). Outsourced shops come back with feature 36.
export class MechanicAssignmentDto {
  @IsUUID()
  id: string;
}

export class NewDriverDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Choose or add a driver.' })
  @MaxLength(100)
  name: string;

  @Transform(trimUpper)
  @IsString()
  @Matches(LICENSE_PATTERN, { message: 'Use the format A01-23-456789.' })
  licenseNumber: string;
}

export class RepairIssueDto {
  // An active IssueCategory (spec 0007, AC-26); replaces the old free text vehicleSystem
  @IsUUID('all', { message: 'Choose a system.' })
  categoryId: string;

  // An Active knowledge entry picked in the repair form; its steps are copied to the issue
  @IsOptional()
  @IsUUID()
  knowledgeEntryId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  rootCause: string;

  // Optional only with a knowledge entry and blank: the server then uses the entry's name
  // (spec 0016, AC-5). Without an entry it is required, 1 to 500 after trimming.
  @Transform(trim)
  @ValidateIf(
    (issue: RepairIssueDto) => !issue.knowledgeEntryId || !!issue.description,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description?: string;
}

export class CreateRepairDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  vehiclePlate: string;

  // Exactly one of driverId and newDriver (spec 0016, AC-6); the service answers the "neither or both" 400
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NewDriverDto)
  newDriver?: NewDriverDto;

  @IsEnum(['ONLINE', 'CORPORATE'], { message: 'Choose an account type.' })
  accountType: 'ONLINE' | 'CORPORATE';

  // An active value of the corporation lookup list; required with CORPORATE (spec 0016, AC-4)
  @IsOptional()
  @IsUUID()
  corporationId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  garageLocation: string;

  @IsNumber()
  @Min(0)
  odometerReading: number;

  // The reading is right even though it jumps far above the last one (spec 0016, AC-7)
  @IsOptional()
  @IsBoolean()
  confirmOdometerJump?: boolean;

  // Optional (spec 0016, AC-1): none means the ticket starts Open
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MechanicAssignmentDto)
  mechanics?: MechanicAssignmentDto[];

  @IsEnum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RepairIssueDto)
  issues: RepairIssueDto[];

  @IsOptional()
  @IsString()
  @MaxLength(50)
  repairNumber?: string;

  // Spec 0029, AC-8: open the ticket from this VMMS referral; the driver becomes optional
  @IsOptional()
  @IsUUID()
  referralId?: string;
}
