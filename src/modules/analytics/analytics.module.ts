import { Module } from '@nestjs/common';
import SharedModule from '../../shared/shared.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

// Spec 0013: live analytics over the VRMS tables, no cache and no copy
@Module({
  imports: [SharedModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
