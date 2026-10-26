import { Global, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { AccountCheck } from './account-check';

// Accounts, passwords and codes live in welinc-auth (spec 0009). VRMS only checks who is calling.
// Global, so the guards resolve AccountCheck in every feature module.
@Global()
@Module({
  imports: [PassportModule],
  providers: [JwtStrategy, AccountCheck, JwtAuthGuard, RolesGuard],
  exports: [AccountCheck],
})
export default class AuthModule {}
