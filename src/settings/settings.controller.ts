import { Body, Controller, Get, Patch, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../auth/permissions/permission.decorators';
import type { PermittedRequest } from '../auth/permissions/permissions.guard';
import { CurrentAbility } from '../auth/permissions/current-ability.decorator';
import type { AppAbility } from '../auth/permissions/ability.factory';
import { ListChangesQueryDto } from './dto/list-changes.dto';
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

  // AC-26. Permission rows only for a caller who also holds permissions.manage.
  @RequirePermission('settings.manage')
  @Get('changes')
  changes(
    @Query() query: ListChangesQueryDto,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.admin.changes(
      query,
      ability.can('permissions.manage', 'Permission'),
    );
  }
}
