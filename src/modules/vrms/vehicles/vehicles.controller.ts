import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
} from '@nestjs/common';
import { RequirePermission } from '../../../auth/permissions/permission.decorators';
import type { AuthUser } from '../../../auth/account-check';
import { UpdateVehicleDto } from '../dto/update-vehicle.dto';
import { VehiclesService } from './vehicles.service';

type AuthRequest = { user: AuthUser };

// Spec 0016, AC-21: the Vehicles section in Settings
@Controller('vrms/vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  // GET /vrms/vehicles
  @RequirePermission('vehicle.manage')
  @Get()
  list() {
    return this.vehicles.list();
  }

  // PATCH /vrms/vehicles/:id
  @RequirePermission('vehicle.manage')
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleDto,
    @Req() req: AuthRequest,
  ) {
    return this.vehicles.update(id, dto, req.user);
  }
}
