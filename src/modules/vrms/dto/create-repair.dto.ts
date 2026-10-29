import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsArray,
  ValidateNested,
  IsEnum,
  IsUUID,
  MaxLength,
  ArrayMinSize,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

// In house mechanics only, by Mechanic id (spec 0010, AC-12). Outsourced shops come back with feature 36.
export class MechanicAssignmentDto {
  @IsUUID()
  id: string;
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

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description: string;
}

export class CreateRepairDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  vehiclePlate: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  driverName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  issueDescription: string;

  @IsEnum(['ONLINE', 'CORPORATE'])
  accountType: 'ONLINE' | 'CORPORATE';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  corporation?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  garageLocation: string;

  @IsNumber()
  @Min(0)
  odometerReading: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MechanicAssignmentDto)
  mechanics: MechanicAssignmentDto[];

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
}
