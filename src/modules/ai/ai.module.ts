import { Module } from '@nestjs/common';
import SharedModule from '../../shared/shared.module';
import { AI_PROVIDER } from './ai-provider';
import { AiController } from './ai.controller';
import { DiagnosisService } from './diagnosis.service';
import { EmbeddingCatchupJob } from './embedding-catchup.job';
import { EmbeddingService } from './embedding.service';
import { GeminiProvider } from './gemini.provider';

// Spec 0013: AI diagnosis and issue embeddings, on the VRMS database only
@Module({
  imports: [SharedModule],
  controllers: [AiController],
  providers: [
    { provide: AI_PROVIDER, useClass: GeminiProvider },
    EmbeddingService,
    EmbeddingCatchupJob,
    DiagnosisService,
  ],
  exports: [EmbeddingService],
})
export class AiModule {}
