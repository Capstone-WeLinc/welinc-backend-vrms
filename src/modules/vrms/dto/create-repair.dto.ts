import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsArray,
  ValidateNested,
  IsEnum,
  IsBoolean,
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
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  vehicleSystem: string;

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
