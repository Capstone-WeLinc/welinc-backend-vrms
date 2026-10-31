import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { SettingsService } from '../../settings/settings.service';
import { withoutSystemPrefix } from '../knowledge/knowledge-grouping';
import { AI_PROVIDER, type AiProvider, EMBED_BATCH_SIZE } from './ai-provider';

type IssueText = { id: string; description: string };

/** What gets embedded: the description without its "[<category>] " prefix (AC-14). */
export function embeddingText(description: string): string {
  return withoutSystemPrefix(description).trim();
}

/** SHA 256 hex of the embedded text; a stored row with another hash is stale. */
export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** pgvector's text form, bound as a parameter and cast `::vector`. */
export function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  /** False while AI is off or no key is set: nothing is embedded (AC-17, AC-20). */
  get enabled(): boolean {
    return this.provider.configured && this.settings.isModuleOn('ai');
  }

  get model(): string {
    return this.provider.embedModel;
  }

  /**
   * Called after a ticket is saved and never awaited (AC-14). Catches and logs every error, so
   * embedding can never fail or slow the save.
   */
  async embedIssuesInBackground(issueIds: string[]): Promise<void> {
    try {
      if (!this.enabled || issueIds.length === 0) return;
      const issues = await this.prisma.repairIssue.findMany({
        where: { id: { in: issueIds } },
        select: { id: true, description: true },
      });
      await this.embedIssues(issues);
    } catch (err) {
      this.logger.warn(
        `Embedding ${issueIds.length} issue(s) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Embeds and stores the issues, up to EMBED_BATCH_SIZE per provider call. Throws on failure. */
  async embedIssues(issues: IssueText[]): Promise<number> {
    for (let start = 0; start < issues.length; start += EMBED_BATCH_SIZE) {
      const batch = issues.slice(start, start + EMBED_BATCH_SIZE);
      const texts = batch.map((issue) => embeddingText(issue.description));
      const vectors = await this.provider.embed(texts, 'RETRIEVAL_DOCUMENT');
      await this.store(
        batch.map((issue, i) => ({
          issueId: issue.id,
          vector: vectors[i],
          hash: textHash(texts[i]),
        })),
      );
    }
    return issues.length;
  }

  /** A symptom as a search query vector. Throws AiProviderError on failure. */
  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.provider.embed([text], 'RETRIEVAL_QUERY');
    return vector;
  }

  // Prisma can't write an Unsupported column, so the upsert is raw SQL
  private async store(
    rows: { issueId: string; vector: number[]; hash: string }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map(
      (row) =>
        Prisma.sql`(${row.issueId}::uuid, ${vectorLiteral(row.vector)}::vector, ${this.model}, ${row.hash}, now(), now())`,
    );
    await this.prisma.$executeRaw`
      INSERT INTO issue_embeddings (issue_id, embedding, model, text_hash, created_at, updated_at)
      VALUES ${Prisma.join(values)}
      ON CONFLICT (issue_id) DO UPDATE
        SET embedding = EXCLUDED.embedding,
            model = EXCLUDED.model,
            text_hash = EXCLUDED.text_hash,
            updated_at = now()
    `;
  }
}
