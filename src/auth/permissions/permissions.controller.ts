import { Controller, Get, Req } from '@nestjs/common';
import { SettingsService } from '../../settings/settings.service';
import { Authenticated, RequirePermission } from './permission.decorators';
import { PermissionMatrixService } from './permission-matrix.service';
import type { PermittedRequest } from './permissions.guard';
import { PermissionsService } from './permissions.service';
import { ApiTags } from '@nestjs/swagger';
import { ApiGenericErrors, ApiUserToken } from '../../openapi/decorators';
import { PrismaService } from '../../shared/prisma.service';
import { isInRoster } from '../../modules/vrms/repair-views';

// Suite spec 0013, AC-30: the matrix is edited in the portal (welinc-auth) and synced here, so
// PATCH /vrms/permissions and GET /vrms/permissions/changes are gone.
@ApiTags('Permissions')
@ApiUserToken()
@ApiGenericErrors()
@Controller('vrms/permissions')
export class PermissionsController {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly matrix: PermissionMatrixService,
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
  ) {}

  // Spec 0011, AC-16: keys only. Rules with conditions stay on the server. Spec 0012, AC-12:
  // keys of an off module are already removed, and `modules` says which are on. Spec 0027:
  // `inRoster` (an active, assignable roster row) decides the "Assigned to me" sub page.
  @Authenticated()
  @Get('me')
  async me(@Req() req: PermittedRequest) {
    return {
      keys: [...this.permissions.keysFor(req.user.roles.map((r) => r.role))],
      version: this.permissions.currentVersion,
      modules: this.settings.modules(),
      inRoster: await isInRoster(this.prisma, req.user.sub),
    };
  }

  // Spec 0011, AC-17: the synced copy, read only. permissions.manage left with the editor, so
  // the Admins who hold settings.manage (locked on for Admin) read it.
  @RequirePermission('settings.manage')
  @Get()
  view() {
    return this.matrix.view();
  }
}
