import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '../../../auth/roles';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { ConfigService } from './config.service';
import { MechanicRoster } from '../mechanic-roster.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vrms')
export class ConfigController {
  constructor(
    private readonly configService: ConfigService,
    private readonly mechanicRoster: MechanicRoster,
  ) {}

  // GET /vrms/config/garages — Admin + Mechanic
  @Roles(UserRole.ADMIN, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC)
  @Get('config/garages')
  listGarages() {
    return this.configService.listGarages();
  }

  // GET /vrms/config/vehicles — Admin + Mechanic
  @Roles(UserRole.ADMIN, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC)
  @Get('config/vehicles')
  listVehicles() {
    return this.configService.listVehicles();
  }

  // GET /vrms/mechanics/available — Admin + Mechanic
  @Roles(UserRole.ADMIN, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC)
  @Get('mechanics/available')
  listAvailableMechanics() {
    return this.configService.listAvailableMechanics();
  }

  // POST /vrms/mechanics/sync — Admin. Brings the in house mechanics in step with welinc-auth,
  // asking as the calling admin (spec 0009, AC-11)
  @Roles(UserRole.ADMIN)
  @Post('mechanics/sync')
  @HttpCode(HttpStatus.OK)
  syncMechanics(@Headers('authorization') authorization: string) {
    return this.mechanicRoster.sync(authorization.replace(/^Bearer\s+/i, ''));
  }

  // GET /vrms/config/drivers — Admin + Mechanic (autocomplete suggestions)
  @Roles(UserRole.ADMIN, UserRole.MECHANIC, UserRole.CHIEF_MECHANIC)
  @Get('config/drivers')
  listDrivers() {
    return this.configService.listDrivers();
  }
}
