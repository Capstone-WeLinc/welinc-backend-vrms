import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsString, IsUUID, MaxLength } from 'class-validator';

// Spec 0029 (child 0001), AC-2: VMMS's "this changed" message, the same body it sends BMS. Only
// the entity is used: VRMS reads it fresh, never trusting the message for field values.

export class FleetChangeDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  eventId!: string;

  @ApiProperty({ enum: ['VEHICLE', 'GARAGE'] })
  @IsIn(['VEHICLE', 'GARAGE'])
  entityType!: 'VEHICLE' | 'GARAGE';

  @ApiProperty({
    format: 'uuid',
    description: 'The VMMS id of the truck or garage',
  })
  @IsUUID()
  entityId!: string;

  @ApiProperty({
    description:
      "Any of VMMS's values (VEHICLE_CREATED, VEHICLE_UPDATED, VEHICLE_DELETED, GARAGE_UPDATED, …); only logged",
  })
  @IsString()
  @MaxLength(60)
  changeType!: string;

  @ApiProperty({ format: 'date-time' })
  @IsISO8601()
  occurredAt!: string;
}

export class FleetChangeAcceptedView {
  @ApiProperty({ enum: [true] })
  accepted!: true;
}
