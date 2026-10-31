import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { EmbeddingService } from '../src/modules/ai/embedding.service';
import { EMBED_BATCH_SIZE } from '../src/modules/ai/ai-provider';
import { SettingsService } from '../src/settings/settings.service';

// Spec 0013, AC-16: embed every missing or stale issue regardless of age, 50 at a time.
// The free tier allows 100 texts a minute, so a pause follows each batch. On a provider error it
// retries once after 2 seconds, then stops and exits non zero. Safe to run again.

const PAUSE_MS = 31_000;
const RETRY_MS = 2_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const log = new Logger('ai:embed-all');
  try {
    // Settings normally load on the first checked request; here nothing has asked yet
    await app.get(SettingsService).load();
    const embeddings = app.get(EmbeddingService);
    if (!embeddings.enabled) {
      log.error('AI is off or GEMINI_API_KEY is not set: nothing to do');
      process.exitCode = 1;
      return;
    }
    const stale = await embeddings.staleIssues();
    log.log(`${stale.length} issue(s) need an embedding`);
    let done = 0;
    for (let start = 0; start < stale.length; start += EMBED_BATCH_SIZE) {
      const batch = stale.slice(start, start + EMBED_BATCH_SIZE);
      try {
        await embeddings.embedIssues(batch);
      } catch {
        await sleep(RETRY_MS);
        await embeddings.embedIssues(batch);
      }
      done += batch.length;
      log.log(`Embedded ${done} of ${stale.length}`);
      if (done < stale.length) await sleep(PAUSE_MS);
    }
    log.log('Done');
  } catch (err) {
    log.error(
      `Stopped: ${err instanceof Error ? err.message : String(err)}. Run it again to continue.`,
    );
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
