import { Controller, Get, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { ConfigService } from './config.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vrms')
export class ConfigController {
  constructor(private readonly configService: ConfigService) {}

  // GET /vrms/config/garages — Admin + Mechanic
  @Roles(UserRole.ADMIN, UserRole.MECHANIC)
  @Get('config/garages')
  listGarages() {
    return this.configService.listGarages();
  }

  // GET /vrms/config/vehicles — Admin + Mechanic
  @Roles(UserRole.ADMIN, UserRole.MECHANIC)
  @Get('config/vehicles')
  listVehicles() {
    return this.configService.listVehicles();
  }

  // GET /vrms/mechanics/available — Admin + Mechanic
  @Roles(UserRole.ADMIN, UserRole.MECHANIC)
  @Get('mechanics/available')
  listAvailableMechanics() {
    return this.configService.listAvailableMechanics();
  }

  // GET /vrms/config/drivers — Admin + Mechanic (autocomplete suggestions)
  @Roles(UserRole.ADMIN, UserRole.MECHANIC)
  @Get('config/drivers')
  listDrivers() {
    return this.configService.listDrivers();
  }
}
