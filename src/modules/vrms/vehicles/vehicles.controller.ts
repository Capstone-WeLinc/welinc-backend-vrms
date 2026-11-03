import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { RequirePermission } from '../../../auth/permissions/permission.decorators';
import type { AuthUser } from '../../../auth/account-check';
import { SetVehicleStatusDto } from '../dto/set-vehicle-status.dto';
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

  // POST /vrms/vehicles/:id/status (spec 0020, AC-1 to AC-5a)
  @RequirePermission('vehicle.manage')
  @Post(':id/status')
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetVehicleStatusDto,
    @Req() req: AuthRequest,
  ) {
    return this.vehicles.setStatus(id, dto, req.user);
  }
}
