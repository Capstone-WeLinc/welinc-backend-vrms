import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import SharedModule from './shared/shared.module';
import AuthModule from './auth/auth.module';
import { VrmsModule } from './modules/vrms/vrms.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { AiModule } from './modules/ai/ai.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    SharedModule,
    AuthModule,
    VrmsModule,
    KnowledgeModule,
    AiModule,
    AnalyticsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
