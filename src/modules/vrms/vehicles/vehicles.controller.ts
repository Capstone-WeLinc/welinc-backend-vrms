import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermission } from '../../../auth/permissions/permission.decorators';
import { VehicleChangesQueryDto } from '../dto/vehicle-changes-query.dto';
import { VehiclesService } from './vehicles.service';
import { ApiTags } from '@nestjs/swagger';
import { ApiGenericErrors, ApiUserToken } from '../../../openapi/decorators';

// Spec 0016, AC-21: the Vehicles section in Settings. Read only since spec 0029 (AC-4): VMMS
// owns the trucks, and only the fleet sync writes them.
@ApiTags('Vehicles')
@ApiUserToken()
@ApiGenericErrors()
@Controller('vrms/vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  // GET /vrms/vehicles
  @RequirePermission('vehicle.manage')
  @Get()
  list() {
    return this.vehicles.list();
  }

  // GET /vrms/vehicles/:id/changes (spec 0020, AC-9)
  @RequirePermission('vehicle.manage')
  @Get(':id/changes')
  changes(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: VehicleChangesQueryDto,
  ) {
    return this.vehicles.changes(id, query);
  }
}
