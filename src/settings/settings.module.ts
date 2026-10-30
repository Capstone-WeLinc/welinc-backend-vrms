import { Global, Module } from '@nestjs/common';
import SharedModule from '../shared/shared.module';
import { SettingsAdminService } from './settings-admin.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

// Spec 0012. Global so any service reads a setting through SettingsService.get (AC-3).
@Global()
@Module({
  imports: [SharedModule],
  controllers: [SettingsController],
  providers: [SettingsService, SettingsAdminService],
  exports: [SettingsService],
})
export default class SettingsModule {}
