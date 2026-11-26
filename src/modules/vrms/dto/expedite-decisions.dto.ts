import { ApiProperty } from '@nestjs/swagger';
import { RepairPriority } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Spec 0029 (child 0003), AC-19: answering a BMS expedite request.

/** POST /vrms/expedite-requests/:id/accept. */
export class AcceptExpediteDto {
  @ApiProperty({ enum: RepairPriority })
  @IsEnum(RepairPriority)
  priority: RepairPriority;

  /** The new expected return date; omitted keeps the ticket's. */
  @ApiProperty({ required: false, format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  dueAt?: string;

  /** The ticket as the dialog loaded it: a change since answers 409 `STALE`. */
  @ApiProperty({ format: 'date-time' })
  @IsISO8601()
  updatedAt: string;
}

/** POST /vrms/expedite-requests/:id/decline. */
export class DeclineExpediteDto {
  @ApiProperty({ minLength: 5, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @Length(5, 500, { message: 'Say why, in 5 to 500 characters.' })
  reason: string;
}

/** One waiting request, on the ticket page banner and the Admin dashboard list. */
export class ExpediteRequestView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'JO-2026-0142' })
  jobOrderNumber: string;

  @ApiProperty()
  reason: string;

  @ApiProperty({ type: String, nullable: true, example: '2026-12-02' })
  neededBy: string | null;

  @ApiProperty({ format: 'date-time' })
  receivedAt: string;

  @ApiProperty({ format: 'uuid' })
  repairTicketId: string;

  @ApiProperty()
  repairNumber: string;

  @ApiProperty()
  vehiclePlate: string;

  @ApiProperty({ enum: RepairPriority })
  ticketPriority: RepairPriority;
}

export class ExpediteRequestListResponse {
  @ApiProperty({ type: [ExpediteRequestView] })
  items: ExpediteRequestView[];

  @ApiProperty({ description: 'Every waiting request, for the dashboard tile' })
  waitingCount: number;
}
