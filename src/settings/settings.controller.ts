import { Body, Controller, Get, Patch, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../auth/permissions/permission.decorators';
import type { PermittedRequest } from '../auth/permissions/permissions.guard';
import { ListChangesQueryDto } from './dto/list-changes.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SettingsAdminService } from './settings-admin.service';
import { ApiTags } from '@nestjs/swagger';
import { ApiGenericErrors, ApiUserToken } from '../openapi/decorators';

@ApiTags('Settings')
@ApiUserToken()
@ApiGenericErrors()
@Controller('vrms/settings')
export class SettingsController {
  constructor(private readonly admin: SettingsAdminService) {}

  // Spec 0012, API surface
  @RequirePermission('settings.manage')
  @Get()
  view() {
    return this.admin.view();
  }

  // AC-5 to AC-9
  @RequirePermission('settings.manage')
  @Patch()
  update(@Body() dto: UpdateSettingsDto, @Req() req: PermittedRequest) {
    return this.admin.update(dto, req.user);
  }

  // AC-26: settings and lookup changes (permission changes are in the portal, suite spec 0013)
  @RequirePermission('settings.manage')
  @Get('changes')
  changes(@Query() query: ListChangesQueryDto) {
    return this.admin.changes(query);
  }
}
