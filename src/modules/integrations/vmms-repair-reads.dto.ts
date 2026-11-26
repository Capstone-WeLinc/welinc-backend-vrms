import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

// Spec 0029 (child 0002): the two reads VMMS calls, and what they answer (AC-14, AC-15).

const VMMS_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'ON_HOLD',
  'OUTSOURCED',
  'FOR_VERIFICATION',
  'CLOSED',
  'CANCELLED',
];

/** AC-15: `limit` 1 to 100, default 50; the cursor is opaque. */
export class RepairHistoryQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'The `nextCursor` of the page before, passed back unchanged',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class RepairStatusView {
  @ApiProperty({ format: 'uuid' })
  repairTicketId!: string;

  @ApiProperty({ example: 'REP-20261127-7J6W' })
  repairTicketNumber!: string;

  @ApiProperty({
    enum: VMMS_STATUSES,
    description: "VRMS's Pending approval is sent as OUTSOURCED",
  })
  status!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Only while OUTSOURCED',
  })
  outsideShopName!: string | null;
}

export class RepairHistoryItem {
  @ApiProperty({ format: 'uuid' })
  repairTicketId!: string;

  @ApiProperty({ example: 'REP-20261127-7J6W' })
  repairTicketNumber!: string;

  @ApiProperty({ format: 'date-time' })
  openedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: string | null;

  @ApiProperty({ enum: VMMS_STATUSES })
  status!: string;

  @ApiProperty({ type: [String], example: ['Brakes: grinding front left'] })
  issues!: string[];

  @ApiProperty({
    type: [String],
    example: ['Brake pad set x2'],
    description: 'Never a price',
  })
  partsUsed!: string[];

  @ApiProperty({ type: [String], description: 'Mechanic names' })
  repairPersonnel!: string[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The outside shop',
  })
  provider!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '12500.00',
    description: 'The ticket total as a decimal string',
  })
  totalRepairCost!: string | null;
}

export class RepairHistoryResponse {
  @ApiProperty({
    type: [RepairHistoryItem],
    description: 'Newest first; never cancelled tickets',
  })
  items!: RepairHistoryItem[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
