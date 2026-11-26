import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * VRMS spec 0026, AC-5: the reply shapes of the four ticket routes, read from
 * `RepairsService.formatTicket` and `present`. The AC-6 tests in
 * `src/openapi/ticket-replies.spec.ts` keep them in step with what the controller sends.
 */

const STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'ON_HOLD',
  'FOR_VERIFICATION',
  'OUTSOURCED',
  'PENDING_APPROVAL',
  'CLOSED',
  'CANCELLED',
];

export class TicketKnowledgeEntryView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  categoryId!: string;

  @ApiProperty({ enum: ['DRAFT', 'ACTIVE', 'INACTIVE'] })
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  safetyNotes!: string | null;

  @ApiProperty({ type: [String], description: 'Part names, in entry order' })
  parts!: string[];

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Hours past repairs took; null until enough closed tickets',
  })
  typicalHours!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  estimatedHours!: number | null;
}

export class TicketStepView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  position!: number;

  @ApiProperty()
  text!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  checkedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  checkedByEmail!: string | null;

  @ApiProperty({ enum: ['KNOWN_FIX', 'ADDED'] })
  origin!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  editedAt!: string | null;
}

export class TicketIssueView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ type: String, nullable: true })
  categoryId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  categoryName!: string | null;

  @ApiProperty({
    type: TicketKnowledgeEntryView,
    nullable: true,
    description: 'The linked known fix; null when none is linked',
  })
  knowledgeEntry!: TicketKnowledgeEntryView | null;

  @ApiProperty({
    description: 'The checklist lock the Edit steps dialog sends back',
  })
  checklistVersion!: number;

  @ApiProperty({ type: [TicketStepView] })
  steps!: TicketStepView[];

  @ApiProperty({ type: String, nullable: true })
  resolutionNote!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  hoursSpent!: number | null;

  @ApiProperty({ type: Boolean, nullable: true })
  followedKnownFix!: boolean | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt!: string | null;
}

export class TicketMechanicView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;
}

export class TicketPartView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty()
  unitCost!: number;

  @ApiProperty()
  quantity!: number;

  @ApiProperty()
  subtotal!: number;
}

/** What the caller may do on this ticket, so the web app never guesses. */
export class TicketAbilitiesView {
  @ApiProperty()
  work!: boolean;

  @ApiProperty()
  administer!: boolean;

  @ApiProperty({ description: 'False on a ticket the caller is assigned to' })
  verify!: boolean;

  @ApiProperty()
  editCosts!: boolean;

  @ApiProperty()
  unlock!: boolean;

  @ApiProperty()
  assign!: boolean;

  @ApiProperty()
  edit!: boolean;

  @ApiProperty()
  editChecklist!: boolean;
}

/** One ticket as a list row. */
export class TicketView {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'REP-20261116-A1B2' })
  repairNumber!: string;

  @ApiProperty({ enum: STATUSES })
  status!: string;

  @ApiProperty()
  vehiclePlate!: string;

  @ApiProperty()
  vehicleModel!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Null on a ticket opened from a VMMS referral (spec 0029, AC-12)',
  })
  driverName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  driverId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The VMMS work order number when the ticket was opened from a VMMS referral (spec 0029, AC-12)',
  })
  fromVmmsWorkOrder!: string | null;

  @ApiProperty({
    description:
      'An open ticket whose truck VMMS removed (inactive in the fleet copy); worked out on read (spec 0029, AC-35)',
  })
  truckRemoved!: boolean;

  @ApiProperty({ description: 'The garage name' })
  garageLocation!: string;

  @ApiProperty()
  odometerReading!: number;

  @ApiProperty({ enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] })
  priority!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  dueAt!: string | null;

  @ApiProperty({
    enum: ['PRIORITY', 'ISSUE_TYPE', 'MANUAL'],
    nullable: true,
  })
  dueAtSource!: string | null;

  @ApiProperty({ type: String, nullable: true })
  reportedByName!: string | null;

  @ApiProperty({
    enum: ['ONLINE', 'CORPORATE'],
    nullable: true,
    description: 'Null on tickets made before it was stored',
  })
  accountType!: string | null;

  @ApiProperty({ type: String, nullable: true })
  corporation!: string | null;

  @ApiProperty({ type: String, nullable: true })
  verifiedByName!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  verifiedAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'The last edit after create; null until someone edits',
  })
  editedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  editedByName!: string | null;

  @ApiProperty({ description: 'Every issue description, joined with commas' })
  issueDescription!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({ format: 'date-time' })
  lastActivityAt!: string;

  @ApiProperty({ format: 'date-time' })
  statusChangedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  cancellationReason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  remarks!: string | null;

  @ApiProperty({ type: [TicketIssueView] })
  issues!: TicketIssueView[];

  @ApiProperty({ type: [TicketMechanicView] })
  mechanics!: TicketMechanicView[];

  @ApiProperty()
  mechanicCount!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Null when not recorded or when the caller may not read costs',
  })
  partsCost!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  laborCost!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  totalCost!: number | null;

  @ApiProperty({ description: 'An open ticket with a deactivated mechanic' })
  hasInactiveMechanic!: boolean;

  @ApiProperty({
    description: 'In progress or on hold with no active mechanic',
  })
  needsMechanic!: boolean;

  @ApiProperty({ type: TicketAbilitiesView })
  can!: TicketAbilitiesView;

  @ApiPropertyOptional({
    description: 'Only for a caller who may read the total cost',
  })
  isLumpSum?: boolean;

  @ApiPropertyOptional({
    description: 'Only for a caller who may read the total cost',
  })
  isUnlocked?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Only for a caller who may read the total cost',
  })
  unlockReason?: string | null;

  @ApiPropertyOptional({
    description: 'Only for a caller who may read the total cost',
  })
  driverIsVerified?: boolean;

  @ApiPropertyOptional({
    type: [TicketPartView],
    description: 'Only for a caller who may read the total cost',
  })
  repairParts?: TicketPartView[];
}

/** `GET /vrms/repairs`: open tickets in the caller's scope. */
export class TicketListResponse {
  @ApiProperty({ type: [TicketView] })
  data!: TicketView[];

  @ApiProperty({ description: 'Every matching ticket, across all pages' })
  total!: number;
}

/** A status move the caller may make now. */
export class TicketMoveView {
  @ApiProperty({ enum: STATUSES })
  to!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty({ enum: ['forward', 'back', 'cancel'] })
  kind!: string;

  @ApiProperty({
    enum: ['resolutions', 'remarks', 'cancellationReason', 'costs'],
    nullable: true,
    description: 'What the move dialog must ask for; null when nothing',
  })
  needs!: string | null;

  @ApiProperty({
    enum: ['beforePhoto', 'afterPhoto'],
    nullable: true,
    description: 'A photo the ticket still needs before this move',
  })
  blockedBy!: string | null;
}

/** The last time the ticket was sent back from verification. */
export class TicketRejectionView {
  @ApiProperty()
  remarks!: string;

  @ApiProperty()
  byName!: string;

  @ApiProperty({ format: 'date-time' })
  at!: string;
}

/**
 * One ticket in full: `GET /vrms/repairs/:id`, and the reply of `POST /vrms/repairs` and
 * `PATCH /vrms/repairs/:id/status`.
 */
export class TicketDetailResponse extends TicketView {
  @ApiProperty({ type: [TicketMoveView] })
  moves!: TicketMoveView[];

  @ApiProperty({
    type: TicketRejectionView,
    nullable: true,
    description: 'Only while in progress or on hold after a send back',
  })
  lastRejection!: TicketRejectionView | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'The first move into In progress or Outsourced; never cleared',
  })
  workStartedAt!: string | null;
}

/** `POST /vrms/repairs`: the ticket, plus whether the truck came from the copy (spec 0029, AC-5). */
export class TicketCreatedResponse extends TicketDetailResponse {
  @ApiProperty({
    description:
      "True when VMMS couldn't be reached and the truck's facts came from VRMS's last copy",
  })
  fleetStale!: boolean;
}
