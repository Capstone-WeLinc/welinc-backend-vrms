import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { AuthUser } from '../../auth/account-check';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { CurrentAbility } from '../../auth/permissions/current-ability.decorator';
import { RequirePermission } from '../../auth/permissions/permission.decorators';
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

type AuthRequest = { user: AuthUser };

// Spec 0011, Route to key mapping. Ownership and hidden fields come from the ability.
@Controller('vrms/repairs')
export class RepairsController {
  constructor(private readonly repairsService: RepairsService) {}

  @RequirePermission('ticket.create')
  @Post()
  create(
    @Body() dto: CreateRepairDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.repairsService.create(dto, req.user, ability);
  }

  // Open tickets, scoped to what the caller may read
  @RequirePermission('ticket.view', 'ticket.view_all')
  @Get()
  findAll(
    @Query() query: FindRepairsQueryDto,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.repairsService.findAll(query, ability);
  }

  // Repair history (closed + cancelled), scoped the same way
  @RequirePermission('ticket.view', 'ticket.view_all')
  @Get('history')
  findHistory(
    @Query() query: HistoryQueryDto,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.repairsService.findHistory(query, ability);
  }

  // In house mechanics not currently on any active ticket
  @RequirePermission('ticket.create')
  @Get('available-mechanics')
  listAvailableMechanics() {
    return this.repairsService.listAvailableMechanics();
  }

  // Audit timeline, keyset paged (declared before :id)
  @RequirePermission('audit.view')
  @Get('audit-logs')
  findAuditEvents(@Query() query: AuditEventsQueryDto) {
    return this.repairsService.findAuditEvents(query);
  }

  // Everyone who appears in the audit log, for the Person filter
  @RequirePermission('audit.view')
  @Get('audit-logs/actors')
  findAuditActors() {
    return this.repairsService.findAuditActors();
  }

  // Single repair detail; outside the caller's scope is a 403
  @RequirePermission('ticket.view', 'ticket.view_all')
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.repairsService.findOne(id, ability);
  }

  // Status moves; each move's own right is checked in the service (spec 0014, AC-5, AC-6)
  @RequirePermission('ticket.work', 'ticket.administer', 'ticket.verify')
  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRepairStatusDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.repairsService.updateStatus(id, dto, req.user, ability);
  }

  // Link, relink or unlink a known fix (spec 0007, AC-29)
  @RequirePermission('ticket.work', 'ticket.administer')
  @Patch(':id/issues/:issueId/knowledge')
  linkKnowledge(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body() dto: LinkIssueKnowledgeDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.repairsService.linkKnowledge(
      id,
      issueId,
      dto,
      req.user,
      ability,
    );
  }

  // Tick a known fix step (spec 0007, AC-28)
  @RequirePermission('ticket.work', 'ticket.administer')
  @Patch(':id/issues/:issueId/steps/:stepId')
  checkStep(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() dto: CheckIssueStepDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.repairsService.checkStep(
      id,
      issueId,
      stepId,
      dto,
      req.user,
      ability,
    );
  }

  // Update costs (lump sum or itemized parts)
  @RequirePermission('ticket.costs.edit')
  @Patch(':id/costs')
  updateCosts(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCostsDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.repairsService.updateCosts(id, dto, req.user, ability);
  }

  // Unlock a terminal (closed/cancelled) ticket for editing
  @RequirePermission('ticket.unlock')
  @Patch(':id/unlock')
  unlockTicket(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UnlockTicketDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.repairsService.unlockTicket(id, dto, req.user, ability);
  }
}
