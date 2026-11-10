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
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { SessionModule } from './session/session.module';
import { HealthController } from './health/health.controller';
import { validateEnv } from './config/env';

@Module({
  imports: [
    // Spec 0010: the whole environment is checked here, before any module reads it
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    SharedModule,
    AuthModule,
    VrmsModule,
    KnowledgeModule,
    AiModule,
    AnalyticsModule,
    AttachmentsModule,
    SessionModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
