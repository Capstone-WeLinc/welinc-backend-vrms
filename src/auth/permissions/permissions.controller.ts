import { Controller, Get, Req } from '@nestjs/common';
import { Authenticated } from './permission.decorators';
import type { PermittedRequest } from './permissions.guard';
import { PermissionsService } from './permissions.service';

@Controller('vrms/permissions')
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  // Spec 0011, AC-16: keys only. Rules with conditions stay on the server.
  @Authenticated()
  @Get('me')
  me(@Req() req: PermittedRequest) {
    return {
      keys: [...this.permissions.keysFor(req.user.roles.map((r) => r.role))],
      version: this.permissions.currentVersion,
    };
  }
}
