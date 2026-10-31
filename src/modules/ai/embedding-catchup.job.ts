import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EmbeddingService } from './embedding.service';

/** Spec 0013, AC-15: every 10 minutes, embed issues that have no current embedding. */
@Injectable()
export class EmbeddingCatchupJob {
  private readonly logger = new Logger(EmbeddingCatchupJob.name);

  constructor(private readonly embeddings: EmbeddingService) {}

  @Cron('0 */10 * * * *')
  async run(): Promise<void> {
    try {
      const count = await this.embeddings.catchUp();
      if (count > 0) this.logger.log(`Catch up embedded ${count} issue(s)`);
    } catch (err) {
      // A provider error stops the pass; the next run tries again
      this.logger.warn(
        `Catch up stopped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
