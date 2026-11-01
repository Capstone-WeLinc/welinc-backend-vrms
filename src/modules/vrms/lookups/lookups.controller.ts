import { Controller, Get, Param } from '@nestjs/common';
import { RequirePermission } from '../../../auth/permissions/permission.decorators';
import { LookupsService } from './lookups.service';

@Controller('vrms/lookups')
export class LookupsController {
  constructor(private readonly lookups: LookupsService) {}

  // GET /vrms/lookups/:list (spec 0016, AC-19)
  @RequirePermission('config.read')
  @Get(':list')
  listActive(@Param('list') list: string) {
    return this.lookups.listActive(list);
  }
}
