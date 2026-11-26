import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

// Spec 0029 (child 0002): VMMS's referral as its sender builds it. Strict on ids, the odometer
// and the findings count; lenient on text (cut, not refused), because VMMS never retries a 4xx.
// Text fields are any string here, including empty, and the service trims and cuts them.

export class ReferralFindingDto {
  @ApiProperty({ description: 'VMMS checklist item id; may be empty' })
  @IsString()
  checklistItemId!: string;

  @ApiProperty({
    description: 'Cut to 200 characters; empty becomes "Finding"',
  })
  @IsString()
  label!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Cut to 2000 characters; empty becomes null',
  })
  @IsOptional()
  @IsString()
  note!: string | null;
}

export class RepairReferralDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  referralId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  vmmsVehicleId!: string;

  @ApiProperty({ description: 'Cut to 20 characters' })
  @IsString()
  vehiclePlate!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  maintenanceScheduleId!: string;

  @ApiProperty({ description: 'Cut to 40 characters' })
  @IsString()
  workOrderNumber!: string;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(2147483647)
  odometerReading!: number;

  @ApiProperty({ type: [ReferralFindingDto], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReferralFindingDto)
  findings!: ReferralFindingDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Cut to 4000 characters; empty becomes null',
  })
  @IsOptional()
  @IsString()
  chiefMechanicRemarks!: string | null;
}

export class ReferralAcceptedView {
  @ApiProperty({ format: 'uuid' })
  referralId!: string;

  @ApiProperty({
    enum: ['WAITING', 'OPENED_TICKET', 'ADDED_TO_TICKET', 'REJECTED'],
  })
  status!: string;

  @ApiProperty({
    description:
      'True when this referral id was already received with the same body',
  })
  duplicate!: boolean;
}
