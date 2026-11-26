import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

// Spec 0029 (child 0003): what BMS sends VRMS, and what VRMS answers it.

export class ExpediteRequestDto {
  @ApiProperty({ format: 'uuid', description: 'The duplicate key' })
  @IsUUID()
  requestId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  vmmsVehicleId!: string;

  @ApiProperty({ minLength: 1, maxLength: 40, example: 'JO-2026-0142' })
  @IsString()
  @Length(1, 40)
  jobOrderNumber!: string;

  @ApiProperty({ minLength: 5, maxLength: 1000 })
  @IsString()
  @Length(5, 1000)
  reason!: string;

  @ApiProperty({
    required: false,
    example: '2026-12-02',
    description: 'YYYY-MM-DD, Asia/Manila',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'neededBy must be YYYY-MM-DD' })
  neededBy?: string;
}

export class ExpediteAcceptedView {
  @ApiProperty({ format: 'uuid' })
  requestId!: string;

  @ApiProperty({ enum: ['WAITING', 'ACCEPTED', 'DECLINED'] })
  status!: string;

  @ApiProperty({ example: 'REP-20261127-0007' })
  repairTicketNumber!: string;

  @ApiProperty({ description: 'True when this requestId was already received' })
  duplicate!: boolean;
}

export class ActiveRepairView {
  @ApiProperty({ format: 'uuid' })
  repairTicketId!: string;

  @ApiProperty()
  repairTicketNumber!: string;

  @ApiProperty({ description: "VRMS's own status, all nine values" })
  repairStatus!: string;

  @ApiProperty({ example: 'On hold' })
  repairStatusLabel!: string;

  @ApiProperty({
    description:
      'The issue category names, or "Not yet diagnosed"; never issue text, notes or people',
  })
  reason!: string;

  @ApiProperty()
  issuesResolved!: number;

  @ApiProperty()
  issuesTotal!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expectedReturnAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  openedAt!: string;
}

export class ActiveRepairResponse {
  @ApiProperty({ type: ActiveRepairView, nullable: true })
  repair!: ActiveRepairView | null;
}

export class VehicleScheduleQueryDto {
  @ApiProperty({ format: 'uuid', description: "VRMS's own vehicle id" })
  @IsUUID()
  vehicleId!: string;
}

export class UpcomingTripView {
  @ApiProperty({ example: 'BK-2026-0418' })
  bookingNumber!: string;

  @ApiProperty({ type: String, nullable: true, example: 'JO-2026-0142' })
  jobOrderNumber!: string | null;

  @ApiProperty({
    example: '2026-11-29',
    description: 'YYYY-MM-DD, Asia/Manila',
  })
  serviceDate!: string;

  @ApiProperty({ type: String, nullable: true, example: '06:30' })
  dispatchTime!: string | null;

  @ApiProperty({ example: 'CONFIRMED' })
  status!: string;
}

export class UpcomingTripsResponse {
  @ApiProperty({
    description: "False when BMS can't be reached; items is then absent",
  })
  available!: boolean;

  @ApiProperty({ type: [UpcomingTripView], required: false })
  items?: UpcomingTripView[];
}
