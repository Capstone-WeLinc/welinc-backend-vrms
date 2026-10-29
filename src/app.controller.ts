import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/permissions/permission.decorators';
import {
  MATRIX_UNAVAILABLE,
  PermissionsService,
} from './auth/permissions/permissions.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly permissions: PermissionsService,
  ) {}

  // Health and readiness: fails until the permission matrix has loaded (spec 0011, AC-21)
  @Public()
  @Get()
  getHello(): string {
    if (!this.permissions.isReady) {
      throw new ServiceUnavailableException(MATRIX_UNAVAILABLE);
    }
    return this.appService.getHello();
  }
}
