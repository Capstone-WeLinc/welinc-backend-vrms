import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import SharedModule from '../shared/shared.module';
import SettingsModule from '../settings/settings.module';
import { AuthVerifyModule } from './verify';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AccountCheck } from './account-check';
import { PermissionMatrixService } from './permissions/permission-matrix.service';
import { PermissionsController } from './permissions/permissions.controller';
import { PermissionsGuard } from './permissions/permissions.guard';
import { PermissionsService } from './permissions/permissions.service';

// Accounts, passwords and codes live in welinc-auth (spec 0009). VRMS checks tokens with welinc-auth's
// published keys (spec 0002, src/auth/verify/), confirms who is calling,
// then what their roles may do (spec 0011). Both guards are global and run in this order.
@Global()
@Module({
  imports: [AuthVerifyModule, SharedModule, SettingsModule],
  controllers: [PermissionsController],
  providers: [
    AccountCheck,
    PermissionsService,
    PermissionMatrixService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [AccountCheck, PermissionsService],
})
export default class AuthModule {}
