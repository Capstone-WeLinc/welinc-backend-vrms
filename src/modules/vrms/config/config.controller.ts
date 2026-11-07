import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Body,
} from '@nestjs/common';
import { RequirePermission } from '../../../auth/permissions/permission.decorators';
import { CurrentAbility } from '../../../auth/permissions/current-ability.decorator';
import type { AppAbility } from '../../../auth/permissions/ability.factory';
import { ConfigService } from './config.service';
import type { AuthUser } from '../../../auth/account-check';
import { MechanicRoster } from '../mechanic-roster.service';
import { MechanicWorkService } from '../mechanic-work.service';
import { ReleaseTicketsDto } from '../dto/release-tickets.dto';

@Controller('vrms')
export class ConfigController {
  constructor(
    private readonly configService: ConfigService,
    private readonly mechanicRoster: MechanicRoster,
    private readonly mechanicWork: MechanicWorkService,
  ) {}

  // GET /vrms/config/garages
  @RequirePermission('config.read')
  @Get('config/garages')
  listGarages() {
    return this.configService.listGarages();
  }

  // GET /vrms/config/vehicles
  @RequirePermission('config.read')
  @Get('config/vehicles')
  listVehicles() {
    return this.configService.listVehicles();
  }

  // GET /vrms/vehicles/:id/summary (spec 0016, AC-11)
  @RequirePermission('ticket.create')
  @Get('vehicles/:id/summary')
  vehicleSummary(@Param('id', ParseUUIDPipe) id: string) {
    return this.configService.vehicleSummary(id);
  }

  // GET /vrms/mechanics/available
  @RequirePermission('config.read')
  @Get('mechanics/available')
  listAvailableMechanics() {
    return this.configService.listAvailableMechanics();
  }

  // POST /vrms/mechanics/sync. Brings the in house mechanics in step with welinc-auth,
  // asking as the calling admin (spec 0009, AC-11)
  @RequirePermission('users.manage')
  @Post('mechanics/sync')
  @HttpCode(HttpStatus.OK)
  syncMechanics(@Headers('authorization') authorization: string) {
    return this.mechanicRoster.sync(authorization.replace(/^Bearer\s+/i, ''));
  }

  // GET /vrms/mechanics/workload (feature 57). Static path, so it sits before the :authUserId routes
  @RequirePermission('users.manage')
  @Get('mechanics/workload')
  workload() {
    return this.mechanicWork.workload();
  }

  // GET /vrms/mechanics/roster (spec 0022, AC-2). The Team section's roster; static path, before :authUserId
  @RequirePermission('mechanics.view', 'users.manage')
  @Get('mechanics/roster')
  roster() {
    return this.mechanicWork.listRoster();
  }

  // GET /vrms/mechanics/:authUserId/open-tickets (feature 57; spec 0022, AC-3 opens it to mechanics.view)
  @RequirePermission('users.manage', 'mechanics.view')
  @Get('mechanics/:authUserId/open-tickets')
  openTickets(@Param('authUserId', ParseUUIDPipe) authUserId: string) {
    return this.mechanicWork.openTickets(authUserId);
  }

  // GET /vrms/mechanics/:authUserId/open-work (spec 0011, AC-32)
  @RequirePermission('users.manage')
  @Get('mechanics/:authUserId/open-work')
  openWork(@Param('authUserId', ParseUUIDPipe) authUserId: string) {
    return this.mechanicWork.openWork(authUserId);
  }

  // POST /vrms/mechanics/:authUserId/release-tickets (spec 0011, AC-33)
  @RequirePermission('users.manage')
  @Post('mechanics/:authUserId/release-tickets')
  @HttpCode(HttpStatus.OK)
  releaseTickets(
    @Param('authUserId', ParseUUIDPipe) authUserId: string,
    @Body() dto: ReleaseTicketsDto,
    @Req() req: { user: AuthUser },
    @Headers('authorization') authorization: string,
  ) {
    return this.mechanicWork.release(
      authUserId,
      dto.reason,
      req.user,
      authorization.replace(/^Bearer\s+/i, ''),
    );
  }

  // GET /vrms/config/drivers (autocomplete suggestions)
  @RequirePermission('config.read')
  @Get('config/drivers')
  listDrivers(
    @Query('q') q: string | undefined,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.configService.listDrivers(q, ability);
  }
}
