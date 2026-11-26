import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { AuthUser } from '../../auth/account-check';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { CurrentAbility } from '../../auth/permissions/current-ability.decorator';
import { RequirePermission } from '../../auth/permissions/permission.decorators';
import { RepairsService } from './repairs.service';
import {
  TicketDetailResponse,
  TicketListResponse,
  TicketCreatedResponse,
} from './repairs.response';
import { TicketEditsService } from './ticket-edits.service';
import { ChecklistEditsService } from './checklist-edits.service';
import { SaveChecklistDto } from './dto/save-checklist.dto';
import {
  AddIssueDto,
  EditIssueDto,
  EditTicketDetailsDto,
  SetMechanicsDto,
  TicketEditDto,
} from './dto/edit-ticket.dto';
import { AuditEventsQueryDto } from './dto/audit-events-query.dto';
import { CreateRepairDto } from './dto/create-repair.dto';
import { FindRepairsQueryDto } from './dto/find-repairs-query.dto';
import { HistoryQueryDto } from './dto/history-query.dto';
import { UpdateRepairStatusDto } from './dto/update-repair-status.dto';
import { UpdateCostsDto } from './dto/update-costs.dto';
import { UnlockTicketDto } from './dto/unlock-ticket.dto';
import { AssignMechanicsDto } from './dto/assign-mechanics.dto';
import {
  CheckIssueStepDto,
  LinkIssueKnowledgeDto,
} from './dto/link-issue-knowledge.dto';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  ApiErrors,
  ApiGenericErrors,
  ApiUserToken,
} from '../../openapi/decorators';

type AuthRequest = { user: AuthUser };

// Spec 0011, Route to key mapping. Ownership and hidden fields come from the ability.
@ApiTags('Repair Tickets')
@ApiUserToken()
@ApiGenericErrors()
@Controller('vrms/repairs')
export class RepairsController {
  constructor(
    private readonly repairsService: RepairsService,
    private readonly editsService: TicketEditsService,
    private readonly checklistEdits: ChecklistEditsService,
  ) {}

  @ApiCreatedResponse({ type: TicketCreatedResponse })
  @ApiErrors(422, ['VEHICLE_NOT_IN_VMMS'])
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
  @ApiOkResponse({ type: TicketListResponse })
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

  // Audit timeline, keyset paged (declared before :id)
  @RequirePermission('audit.view')
  @Get('audit-logs')
  findAuditEvents(
    @Query() query: AuditEventsQueryDto,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.repairsService.findAuditEvents(query, ability);
  }

  // Spec 0021, AC-11: the categories and their event types, for building filters
  @RequirePermission('audit.view')
  @Get('audit-logs/catalog')
  findAuditCatalog(@CurrentAbility() ability: AppAbility) {
    return this.repairsService.findAuditCatalog(ability);
  }

  // Everyone who appears in the audit log, for the Person filter
  @RequirePermission('audit.view')
  @Get('audit-logs/actors')
  findAuditActors() {
    return this.repairsService.findAuditActors();
  }

  // Single repair detail; outside the caller's scope is a 403
  @ApiOkResponse({ type: TicketDetailResponse })
  @RequirePermission('ticket.view', 'ticket.view_all')
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.repairsService.findOne(id, ability);
  }

  // Status moves; each move's own right is checked in the service (spec 0014, AC-5, AC-6)
  @ApiOkResponse({ type: TicketDetailResponse })
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

  // Add, reword, remove and reorder one issue's checklist (spec 0023, AC-6)
  @RequirePermission('ticket.checklist.edit')
  @Put(':id/issues/:issueId/steps')
  saveChecklist(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body() dto: SaveChecklistDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.checklistEdits.save(id, issueId, dto, req.user, ability);
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

  // Set the full mechanic list on any open ticket (spec 0019, AC-9 to AC-12)
  @RequirePermission('ticket.assign')
  @Put(':id/assignments')
  setMechanics(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetMechanicsDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.editsService.setMechanics(id, dto, req.user, ability);
  }

  // Spec 0016, AC-17, kept as a thin alias of the PUT that adds to the current list (spec 0019)
  @RequirePermission('ticket.assign')
  @Post(':id/assignments')
  assignMechanics(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignMechanicsDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.editsService.addMechanics(id, dto, req.user, ability);
  }

  // Fix the driver, odometer, priority or account after create (spec 0019, AC-4 to AC-8)
  @RequirePermission('ticket.edit')
  @Patch(':id/details')
  editDetails(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditTicketDetailsDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.editsService.editDetails(id, dto, req.user, ability);
  }

  // Add an issue after create (spec 0019, AC-14)
  @RequirePermission('ticket.edit')
  @Post(':id/issues')
  addIssue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddIssueDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.editsService.addIssue(id, dto, req.user, ability);
  }

  // Reword an issue or change its system (spec 0019, AC-15)
  @RequirePermission('ticket.edit')
  @Patch(':id/issues/:issueId')
  editIssue(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body() dto: EditIssueDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.editsService.editIssue(id, issueId, dto, req.user, ability);
  }

  // Remove an issue; a POST, since proxies may drop a DELETE body (spec 0019, AC-16, AC-17)
  @RequirePermission('ticket.edit')
  @Post(':id/issues/:issueId/remove')
  removeIssue(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body() dto: TicketEditDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.editsService.removeIssue(id, issueId, dto, req.user, ability);
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
