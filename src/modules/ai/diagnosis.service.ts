import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AiDiagnosis, Prisma } from '@prisma/client';
import type { AuthUser } from '../../auth/account-check';
import {
  type AppAbility,
  canViewCosts,
} from '../../auth/permissions/ability.factory';
import { PrismaService } from '../../shared/prisma.service';
import { SettingsService } from '../../settings/settings.service';
import { ModuleDisabledException } from '../../settings/module-disabled';
import { withoutSystemPrefix } from '../knowledge/knowledge-grouping';
import { readableTickets } from '../vrms/ticket-access';
import { isFinished } from '../vrms/ticket-statuses';
import { AI_PROVIDER, type AiProvider, AiProviderError } from './ai-provider';
import {
  AiBusyException,
  AiRateLimitedException,
  AiUnavailableException,
  TicketClosedException,
} from './ai-errors';
import {
  buildPrompt,
  confidenceOf,
  DIAGNOSIS_SCHEMA,
  type DiagnosisInput,
  type DiagnosisResult,
  type HistoryItem,
  type SimilarCase,
  validateReply,
} from './diagnosis-prompt';
import { EmbeddingService, vectorLiteral } from './embedding.service';
import { DiagnosisFeedbackDto } from './dto/diagnosis-feedback.dto';

// Spec 0013, AC-11
export const HOURLY_LIMIT = 20;
const SIMILARITY_FLOOR = 0.6;
const SIMILAR_LIMIT = 5;
const HISTORY_LIMIT = 5;
const RUN_TIMEOUT_MS = 30_000;
const RUN_MAX_WAIT_MS = 5_000;

/** A diagnosis as the API returns it (AC-9), camelCase. */
export type DiagnosisView = {
  id: string;
  ticketId: string;
  createdAt: Date;
  model: string;
  confidence: string;
  latencyMs: number;
  symptom: string;
  similar: SimilarCase[];
  vehicleHistory: HistoryItem[];
  result: DiagnosisResult;
};

/** The stored snapshot, never recomputed; part prices nulled without ticket.costs.view. */
export function presentDiagnosis(
  row: AiDiagnosis,
  ability: AppAbility,
): DiagnosisView {
  const input = row.input as unknown as DiagnosisInput;
  const result = row.result as unknown as DiagnosisResult;
  const costs = canViewCosts(ability);
  return {
    id: row.id,
    ticketId: row.repairTicketId,
    createdAt: row.createdAt,
    model: row.model,
    confidence: row.confidence,
    latencyMs: row.latencyMs,
    symptom: input.symptom,
    similar: row.similar as unknown as SimilarCase[],
    vehicleHistory: input.vehicleHistory,
    result: {
      ...result,
      recommendedParts: result.recommendedParts.map((part) => ({
        ...part,
        estCostPhp: costs ? part.estCostPhp : null,
      })),
    },
  };
}

/** Escapes LIKE wildcards so a part name matches as plain text. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class DiagnosisService {
  private readonly logger = new Logger(DiagnosisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly embeddings: EmbeddingService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  /** POST /vrms/ai/tickets/:ticketId/diagnoses (AC-7 to AC-11). */
  async run(
    ticketId: string,
    user: AuthUser,
    ability: AppAbility,
  ): Promise<DiagnosisView> {
    const ticket = await this.readableTicket(ticketId, ability, {
      vehicle: { select: { plateNumber: true, model: true } },
      issues: { orderBy: { createdAt: 'asc' }, select: { description: true } },
    });
    if (isFinished(ticket.repairStatus)) throw new TicketClosedException();

    // Every input comes from the ticket, never the request (Key invariants)
    const issues = ticket.issues.map((i) => withoutSystemPrefix(i.description));
    const input: Omit<DiagnosisInput, 'vehicleHistory'> = {
      symptom: issues.join('. '),
      issues,
      vehiclePlate: ticket.vehicle.plateNumber,
      vehicleModel: ticket.vehicle.model,
    };

    const started = Date.now();
    try {
      const row = await this.prisma.$transaction(
        async (tx) => {
          await this.checkHourlyLimit(tx, user.sub);
          const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${ticketId}::text, 0)) AS locked
          `;
          if (!locked) throw new AiBusyException();
          if (!this.provider.configured) throw new AiProviderError('No key');

          // One connection per transaction, so these run in turn
          const similar = await this.similarCases(tx, input.symptom, ticketId);
          const vehicleHistory = await this.vehicleHistory(
            tx,
            ticket.vehicleId,
            ticketId,
          );
          const categories = await this.allowedCategories(tx);
          const fullInput: DiagnosisInput = { ...input, vehicleHistory };
          const raw = await this.provider.generateJson<unknown>(
            buildPrompt(fullInput, similar, categories),
            DIAGNOSIS_SCHEMA,
          );
          const result = validateReply(raw, categories);
          result.recommendedParts = await this.pricedParts(
            tx,
            result.recommendedParts.map((p) => p.partName),
          );

          return tx.aiDiagnosis.create({
            data: {
              repairTicketId: ticketId,
              requestedByUserId: user.sub,
              input: fullInput,
              similar,
              result,
              model: this.provider.generationModel,
              confidence: confidenceOf(similar, vehicleHistory.length),
              latencyMs: Date.now() - started,
            },
          });
        },
        { timeout: RUN_TIMEOUT_MS, maxWait: RUN_MAX_WAIT_MS },
      );
      return presentDiagnosis(row, ability);
    } catch (err) {
      // Nothing is stored on a provider failure, and there is no rule based fallback (AC-10)
      if (err instanceof AiProviderError) {
        this.logger.warn(`AI diagnosis failed on ${ticketId}: ${err.message}`);
        throw new AiUnavailableException();
      }
      throw err;
    }
  }

  /** GET /vrms/ai/tickets/:ticketId/diagnoses/latest (AC-9). */
  async latest(ticketId: string, ability: AppAbility) {
    await this.readableTicket(ticketId, ability, {});
    const row = await this.prisma.aiDiagnosis.findFirst({
      where: { repairTicketId: ticketId },
      orderBy: { createdAt: 'desc' },
    });
    return { data: row ? presentDiagnosis(row, ability) : null };
  }

  /** PUT /vrms/ai/diagnoses/:id/feedback (AC-12): one row per caller, replaced on resend. */
  async saveFeedback(
    diagnosisId: string,
    dto: DiagnosisFeedbackDto,
    user: AuthUser,
    ability: AppAbility,
  ) {
    const diagnosis = await this.prisma.aiDiagnosis.findUnique({
      where: { id: diagnosisId },
      select: { repairTicketId: true },
    });
    if (!diagnosis) throw new NotFoundException('Diagnosis not found');
    await this.readableTicket(diagnosis.repairTicketId, ability, {});

    const values = {
      helpful: dto.helpful,
      rating: dto.rating ?? null,
      comment: dto.comment ?? null,
    };
    const row = await this.prisma.aiDiagnosisFeedback.upsert({
      where: { diagnosisId_userId: { diagnosisId, userId: user.sub } },
      create: { diagnosisId, userId: user.sub, ...values },
      update: values,
    });
    return {
      helpful: row.helpful,
      rating: row.rating,
      comment: row.comment,
      updatedAt: row.updatedAt,
    };
  }

  /** GET /vrms/ai/stats (AC-13): counts from the two tables, zeros when empty. */
  async stats() {
    // The route key is analytics.view, so the AI switch is checked here
    if (!this.settings.isModuleOn('ai')) {
      throw new ModuleDisabledException('ai');
    }
    const [total, byModel, feedback, helpful] = await Promise.all([
      this.prisma.aiDiagnosis.count(),
      this.prisma.aiDiagnosis.groupBy({
        by: ['model'],
        _count: { _all: true },
      }),
      this.prisma.aiDiagnosisFeedback.aggregate({
        _count: { _all: true },
        _avg: { rating: true },
      }),
      this.prisma.aiDiagnosisFeedback.count({ where: { helpful: true } }),
    ]);
    const totalFeedback = feedback._count._all;
    return {
      total_interactions: total,
      models_used: Object.fromEntries(
        byModel.map((m) => [m.model, m._count._all]),
      ),
      satisfaction: {
        avg_rating: Math.round((feedback._avg.rating ?? 0) * 100) / 100,
        helpful_count: helpful,
        total_feedback: totalFeedback,
        satisfaction_rate: totalFeedback
          ? Math.round((helpful / totalFeedback) * 1000) / 10
          : 0,
      },
    };
  }

  /** The ticket if the caller may read it, else 404 as ticket reads do (AC-7). */
  private async readableTicket<I extends Prisma.RepairTicketInclude>(
    ticketId: string,
    ability: AppAbility,
    include: I,
  ) {
    const scope = readableTickets(ability);
    const ticket = scope
      ? await this.prisma.repairTicket.findFirst({
          where: { AND: [scope, { id: ticketId }] },
          include,
        })
      : null;
    if (!ticket) throw new NotFoundException('Repair ticket not found');
    return ticket;
  }

  /** 429 on the caller's 21st run within a rolling hour; failed runs store nothing (AC-11). */
  private async checkHourlyLimit(tx: Prisma.TransactionClient, userId: string) {
    const recent = await tx.aiDiagnosis.findMany({
      where: {
        requestedByUserId: userId,
        createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) },
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
      take: HOURLY_LIMIT,
    });
    if (recent.length < HOURLY_LIMIT) return;
    const freesAt = recent[0].createdAt.getTime() + 60 * 60 * 1000;
    throw new AiRateLimitedException(
      Math.max(1, Math.ceil((freesAt - Date.now()) / 1000)),
    );
  }

  /** Step 2: up to 5 issues at 60% or more, same embed model only, never this ticket's. */
  private async similarCases(
    tx: Prisma.TransactionClient,
    symptom: string,
    ticketId: string,
  ): Promise<SimilarCase[]> {
    const query = vectorLiteral(await this.embeddings.embedQuery(symptom));
    const rows = await tx.$queryRaw<
      {
        issue_id: string;
        ticket_id: string;
        repair_number: string;
        description: string;
        similarity: number;
      }[]
    >`
      SELECT ri.id::text AS issue_id, t.id::text AS ticket_id, t.repair_number,
             ri.description, (1 - (e.embedding <=> ${query}::vector))::float8 AS similarity
      FROM issue_embeddings e
      JOIN repair_issues ri ON ri.id = e.issue_id
      JOIN repair_tickets t ON t.id = ri.repair_ticket_id
      WHERE e.model = ${this.embeddings.model}
        AND t.id <> ${ticketId}::uuid
        AND t.repair_status <> 'CANCELLED'
        AND 1 - (e.embedding <=> ${query}::vector) >= ${SIMILARITY_FLOOR}
      ORDER BY e.embedding <=> ${query}::vector
      LIMIT ${SIMILAR_LIMIT}
    `;
    return rows.map((r) => ({
      issueId: r.issue_id,
      ticketId: r.ticket_id,
      repairNumber: r.repair_number,
      description: r.description,
      similarity: Math.round(r.similarity * 1000) / 1000,
    }));
  }

  /** Step 3: the vehicle's last 5 other tickets, newest closed first, open ones last. */
  private async vehicleHistory(
    tx: Prisma.TransactionClient,
    vehicleId: string,
    ticketId: string,
  ): Promise<HistoryItem[]> {
    const tickets = await tx.repairTicket.findMany({
      where: { vehicleId, id: { not: ticketId } },
      orderBy: [
        { closedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      take: HISTORY_LIMIT,
      select: {
        id: true,
        repairNumber: true,
        repairStatus: true,
        closedAt: true,
        issues: {
          orderBy: { createdAt: 'asc' },
          select: { description: true },
        },
      },
    });
    return tickets.map((t) => ({
      ticketId: t.id,
      repairNumber: t.repairNumber,
      status: t.repairStatus,
      closedAt: t.closedAt?.toISOString() ?? null,
      issues: t.issues.map((i) => withoutSystemPrefix(i.description)),
    }));
  }

  /** Active category names plus General, the only answers kept as is. */
  private async allowedCategories(tx: Prisma.TransactionClient) {
    const rows = await tx.issueCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { name: true },
    });
    const names = rows.map((r) => r.name);
    return names.includes('General') ? names : [...names, 'General'];
  }

  /** Step 5: average unit cost of matching parts on counted tickets, null when none. */
  private async pricedParts(tx: Prisma.TransactionClient, names: string[]) {
    const parts: DiagnosisResult['recommendedParts'] = [];
    for (const partName of names) {
      const [row] = await tx.$queryRaw<{ avg: number | null }[]>`
          SELECT ROUND(AVG(p.unit_cost), 2)::float8 AS avg
          FROM repair_parts p
          JOIN repair_tickets t ON t.id = p.repair_ticket_id
          WHERE t.repair_status <> 'CANCELLED'
            AND p.description ILIKE '%' || ${likeLiteral(partName)} || '%'
      `;
      parts.push({ partName, estCostPhp: row?.avg ?? null });
    }
    return parts;
  }
}
