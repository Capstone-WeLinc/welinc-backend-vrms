import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { RequirePermission } from '../auth/permissions/permission.decorators';
import type { PermittedRequest } from '../auth/permissions/permissions.guard';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SettingsAdminService } from './settings-admin.service';

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
}
