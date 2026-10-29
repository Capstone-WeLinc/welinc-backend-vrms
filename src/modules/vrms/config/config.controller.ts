import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { RequirePermission } from '../../../auth/permissions/permission.decorators';
import { ConfigService } from './config.service';
import { MechanicRoster } from '../mechanic-roster.service';

@Controller('vrms')
export class ConfigController {
  constructor(
    private readonly configService: ConfigService,
    private readonly mechanicRoster: MechanicRoster,
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

  // GET /vrms/config/drivers (autocomplete suggestions)
  @RequirePermission('config.read')
  @Get('config/drivers')
  listDrivers() {
    return this.configService.listDrivers();
  }
}
