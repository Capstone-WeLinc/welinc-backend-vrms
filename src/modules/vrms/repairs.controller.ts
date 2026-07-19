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
import { UserRole, RepairStatus } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RepairsService } from './repairs.service';
import { CreateRepairDto } from './dto/create-repair.dto';
import { UpdateRepairStatusDto } from './dto/update-repair-status.dto';
import { UpdateCostsDto } from './dto/update-costs.dto';
import { UnlockTicketDto } from './dto/unlock-ticket.dto';

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

  // ADMIN + MECHANIC — list active repairs (mechanic sees only assigned)
  @Roles(UserRole.ADMIN, UserRole.MECHANIC)
  @Get()
  findAll(
    @Query('search') search?: string,
    @Query('status') status?: RepairStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: AuthRequest,
  ) {
    const p = page ? parseInt(page, 10) : undefined;
    const l = limit ? parseInt(limit, 10) : undefined;
    return this.repairsService.findAll(search, status, p, l, req!.user);
  }

  // ADMIN + MECHANIC — repair history (completed + cancelled)
  @Roles(UserRole.ADMIN, UserRole.MECHANIC)
  @Get('history')
  findHistory(
    @Query('search') search?: string,
    @Query('status') status?: RepairStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: AuthRequest
  ) {
    const p = page ? parseInt(page, 10) : undefined;
    const l = limit ? parseInt(limit, 10) : undefined;
    return this.repairsService.findHistory(search, status, p, l, req!.user);
  }

  // ADMIN only — list in-house mechanics not currently on any active ticket
  @Roles(UserRole.ADMIN)
  @Get('available-mechanics')
  listAvailableMechanics() {
    return this.repairsService.listAvailableMechanics();
  }

  // ADMIN only — get all system audit logs
  @Roles(UserRole.ADMIN)
  @Get('audit-logs/all')
  findAllAuditLogs() {
    return this.repairsService.findAllAuditLogs();
  }

  // ADMIN + MECHANIC — single repair detail
  @Roles(UserRole.ADMIN, UserRole.MECHANIC)
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) {
    return this.repairsService.findOne(id, req.user);
  }

  // ADMIN + MECHANIC — update status (mechanic restricted at service layer)
  @Roles(UserRole.ADMIN, UserRole.MECHANIC)
  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRepairStatusDto,
    @Req() req: AuthRequest,
  ) {
    return this.repairsService.updateStatus(id, dto, req.user);
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
