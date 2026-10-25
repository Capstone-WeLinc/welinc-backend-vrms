import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RepairsService } from './repairs.service';
import { AuditEventsQueryDto } from './dto/audit-events-query.dto';
import { CreateRepairDto } from './dto/create-repair.dto';
import { FindRepairsQueryDto } from './dto/find-repairs-query.dto';
import { HistoryQueryDto } from './dto/history-query.dto';
import { UpdateRepairStatusDto } from './dto/update-repair-status.dto';
import { UpdateCostsDto } from './dto/update-costs.dto';
import { UnlockTicketDto } from './dto/unlock-ticket.dto';
import {
  CheckIssueStepDto,
  LinkIssueKnowledgeDto,
} from './dto/link-issue-knowledge.dto';

type AuthRequest = { user: { sub: string; email: string; roles: { role: UserRole; system: string }[]; system: string } };

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vrms/repairs')
export class RepairsController {
  constructor(private readonly repairsService: RepairsService) {}

  // ADMIN only — create a new repair ticket
  @Roles(UserRole.ADMIN)
  @Post()
  create(@Body() dto: CreateRepairDto, @Req() req: AuthRequest) {
    return this.repairsService.create(dto, req.user);
  }

  // ADMIN + MECHANIC + CHIEF_MECHANIC — list active repairs (mechanic sees only assigned)
  @Roles(UserRole.ADMIN, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC)
  @Get()
  findAll(@Query() query: FindRepairsQueryDto, @Req() req: AuthRequest) {
    return this.repairsService.findAll(query, req.user);
  }

  // ADMIN + MECHANIC + CHIEF_MECHANIC — repair history (completed + cancelled)
  @Roles(UserRole.ADMIN, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC)
  @Get('history')
  findHistory(@Query() query: HistoryQueryDto, @Req() req: AuthRequest) {
    return this.repairsService.findHistory(query, req.user);
  }

  // ADMIN only — list in-house mechanics not currently on any active ticket
  @Roles(UserRole.ADMIN)
  @Get('available-mechanics')
  listAvailableMechanics() {
    return this.repairsService.listAvailableMechanics();
  }

  // ADMIN only — audit timeline, keyset paged (declared before :id)
  @Roles(UserRole.ADMIN)
  @Get('audit-logs')
  findAuditEvents(@Query() query: AuditEventsQueryDto) {
    return this.repairsService.findAuditEvents(query);
  }

  // ADMIN only — everyone who appears in the audit log, for the Person filter
  @Roles(UserRole.ADMIN)
  @Get('audit-logs/actors')
  findAuditActors() {
    return this.repairsService.findAuditActors();
  }

  // ADMIN + MECHANIC + CHIEF_MECHANIC — single repair detail
  @Roles(UserRole.ADMIN, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC)
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) {
    return this.repairsService.findOne(id, req.user);
  }

  // ADMIN + MECHANIC + CHIEF_MECHANIC — update status (mechanic restricted at service layer)
  @Roles(UserRole.ADMIN, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC)
  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRepairStatusDto,
    @Req() req: AuthRequest,
  ) {
    return this.repairsService.updateStatus(id, dto, req.user);
  }

  // ADMIN + assigned MECHANIC or CHIEF_MECHANIC — link, relink or unlink a known fix (spec 0007, AC-29)
  @Roles(UserRole.ADMIN, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC)
  @Patch(':id/issues/:issueId/knowledge')
  linkKnowledge(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body() dto: LinkIssueKnowledgeDto,
    @Req() req: AuthRequest,
  ) {
    return this.repairsService.linkKnowledge(id, issueId, dto, req.user);
  }

  // ADMIN + assigned MECHANIC or CHIEF_MECHANIC — tick a known fix step (spec 0007, AC-28)
  @Roles(UserRole.ADMIN, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC)
  @Patch(':id/issues/:issueId/steps/:stepId')
  checkStep(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() dto: CheckIssueStepDto,
    @Req() req: AuthRequest,
  ) {
    return this.repairsService.checkStep(id, issueId, stepId, dto, req.user);
  }

  // ADMIN only — update costs (lump sum or itemized parts)
  @Roles(UserRole.ADMIN)
  @Patch(':id/costs')
  updateCosts(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCostsDto,
    @Req() req: AuthRequest,
  ) {
    return this.repairsService.updateCosts(id, dto, req.user);
  }

  // ADMIN only — unlock a terminal (completed/cancelled) ticket for editing
  @Roles(UserRole.ADMIN)
  @Patch(':id/unlock')
  unlockTicket(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UnlockTicketDto,
    @Req() req: AuthRequest,
  ) {
    return this.repairsService.unlockTicket(id, dto, req.user);
  }
}
