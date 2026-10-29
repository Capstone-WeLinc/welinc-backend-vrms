import { Body, Controller, Get, Patch, Query, Req } from '@nestjs/common';
import {
  ListPermissionChangesQueryDto,
  UpdatePermissionsDto,
} from './dto/update-permissions.dto';
import { Authenticated, RequirePermission } from './permission.decorators';
import { PermissionMatrixService } from './permission-matrix.service';
import type { PermittedRequest } from './permissions.guard';
import { PermissionsService } from './permissions.service';

@Controller('vrms/permissions')
export class PermissionsController {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly matrix: PermissionMatrixService,
  ) {}

  // Spec 0011, AC-16: keys only. Rules with conditions stay on the server.
  @Authenticated()
  @Get('me')
  me(@Req() req: PermittedRequest) {
    return {
      keys: [...this.permissions.keysFor(req.user.roles.map((r) => r.role))],
      version: this.permissions.currentVersion,
    };
  }

  // AC-17
  @RequirePermission('permissions.manage')
  @Get()
  view() {
    return this.matrix.view();
  }

  // AC-18
  @RequirePermission('permissions.manage')
  @Patch()
  update(@Body() dto: UpdatePermissionsDto, @Req() req: PermittedRequest) {
    return this.matrix.update(dto, req.user);
  }

  // AC-19
  @RequirePermission('permissions.manage')
  @Get('changes')
  changes(@Query() query: ListPermissionChangesQueryDto) {
    return this.matrix.changes(query);
  }
}
