import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsArray,
  ValidateNested,
  IsEnum,
  IsBoolean,
  IsUUID,
  MaxLength,
  ArrayMinSize,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class MechanicAssignmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsBoolean()
  isOutsourced?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  shopName?: string;
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

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  shopName: string;

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
