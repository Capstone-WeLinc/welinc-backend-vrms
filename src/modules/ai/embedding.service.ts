import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { SettingsService } from '../../settings/settings.service';
import { withoutSystemPrefix } from '../knowledge/knowledge-grouping';
import { AI_PROVIDER, type AiProvider, EMBED_BATCH_SIZE } from './ai-provider';

type IssueText = { id: string; description: string };
type CandidateRow = IssueText & {
  model: string | null;
  textHash: string | null;
};
type SqlClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

/** Issues embedded per catch up pass (AC-15). */
export const CATCHUP_LIMIT = 50;

/**
 * The issues that need an embedding: none stored, another model, or a text hash that no longer
 * matches the current text (AC-15). Keeps the given order and stops at `limit`.
 */
export function selectStale(
  rows: CandidateRow[],
  model: string,
  limit: number,
): IssueText[] {
  const stale: IssueText[] = [];
  for (const row of rows) {
    if (stale.length >= limit) break;
    const current =
      row.model === model &&
      row.textHash === textHash(embeddingText(row.description));
    if (!current) stale.push({ id: row.id, description: row.description });
  }
  return stale;
}

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
  async embedIssues(
    issues: IssueText[],
    client: SqlClient = this.prisma,
  ): Promise<number> {
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
        client,
      );
    }
    return issues.length;
  }

  /**
   * One catch up pass (AC-15). Runs in one transaction holding a transaction scoped advisory
   * lock, so only one replica works at a time; a replica that misses the lock skips. Embeds up
   * to CATCHUP_LIMIT stale issues from the last `ai.embed_catchup_days`, oldest first, and stops
   * at the first provider error. Returns how many were embedded.
   */
  async catchUp(): Promise<number> {
    // No request may have loaded settings yet (or in a while), so the job loads them itself
    await this.settings.load();
    if (!this.enabled) return 0;
    const days = this.settings.get('ai.embed_catchup_days');
    return this.prisma.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended('ai.embed_catchup', 0)) AS locked
        `;
        if (!locked) return 0;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const rows = await this.candidates(tx, since);
        const stale = selectStale(rows, this.model, CATCHUP_LIMIT);
        return this.embedIssues(stale, tx);
      },
      { timeout: 60_000, maxWait: 5_000 },
    );
  }

  /** Every missing or stale issue regardless of age, for `npm run ai:embed-all` (AC-16). */
  async staleIssues(): Promise<IssueText[]> {
    const rows = await this.candidates(this.prisma, null);
    return selectStale(rows, this.model, Number.POSITIVE_INFINITY);
  }

  /** Oldest first, with the stored embedding's model and hash (null when there is none). */
  private candidates(
    client: SqlClient,
    since: Date | null,
  ): Promise<CandidateRow[]> {
    return client.$queryRaw<CandidateRow[]>`
      SELECT i.id, i.description, e.model, e.text_hash AS "textHash"
      FROM repair_issues i
      LEFT JOIN issue_embeddings e ON e.issue_id = i.id
      WHERE (${since}::timestamptz IS NULL OR i.created_at >= ${since}::timestamptz)
      ORDER BY i.created_at ASC, i.id ASC
    `;
  }

  /** A symptom as a search query vector. Throws AiProviderError on failure. */
  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.provider.embed([text], 'RETRIEVAL_QUERY');
    return vector;
  }

  // Prisma can't write an Unsupported column, so the upsert is raw SQL
  private async store(
    rows: { issueId: string; vector: number[]; hash: string }[],
    client: SqlClient,
  ): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map(
      (row) =>
        Prisma.sql`(${row.issueId}::uuid, ${vectorLiteral(row.vector)}::vector, ${this.model}, ${row.hash}, now(), now())`,
    );
    await client.$executeRaw`
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
