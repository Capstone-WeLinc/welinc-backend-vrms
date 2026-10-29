import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import SharedModule from '../shared/shared.module';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AccountCheck } from './account-check';
import { PermissionsController } from './permissions/permissions.controller';
import { PermissionsGuard } from './permissions/permissions.guard';
import { PermissionsService } from './permissions/permissions.service';

// Accounts, passwords and codes live in welinc-auth (spec 0009). VRMS only checks who is calling,
// then what their roles may do (spec 0011). Both guards are global and run in this order.
@Global()
@Module({
  imports: [PassportModule, SharedModule],
  controllers: [PermissionsController],
  providers: [
    JwtStrategy,
    AccountCheck,
    PermissionsService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [AccountCheck, PermissionsService],
})
export default class AuthModule {}
