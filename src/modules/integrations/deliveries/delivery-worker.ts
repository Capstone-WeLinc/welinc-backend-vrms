import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import type { Env } from '../../../config/env';
import { reportJobFailure } from '../../../monitoring/job-failure';
import { SettingsService } from '../../../settings/settings.service';
import { ServiceTokens } from '../service-tokens';
import { KIND_ROUTES, type KindRoute } from './delivery-kinds';
import {
  DeliveryStore,
  type ClaimedDelivery,
  type SentVersion,
} from './delivery-store';
import {
  errorFromBody,
  errorFromThrown,
  nextState,
  SEND_TIMEOUT_MS,
  type SendOutcome,
} from './retry-rule';

export const DELIVERY_INTERVAL_MS = 15_000;
/** Rows of different lines are sent side by side, this many at a time. */
export const SEND_CONCURRENCY = 5;

/** Tests pass their own fetch; the app uses the global one. */
export const DELIVERY_FETCH = Symbol('DELIVERY_FETCH');

export type TickResult = { claimed: number; sent: number; failed: number };

/**
 * Spec 0029 (child 0004), AC-21: every 15 s, claims due outbox rows, posts each to the suite
 * gateway with a service token, and writes the outcome by the retry rule. Payloads are sent as
 * stored; only `eventVersion` is filled in, from the ticket, at send time.
 */
@Injectable()
export class DeliveryWorker {
  private readonly logger = new Logger(DeliveryWorker.name);
  private readonly gateway: string;
  private readonly fetchFn: typeof fetch;
  private running = false;

  constructor(
    private readonly store: DeliveryStore,
    private readonly tokens: ServiceTokens,
    private readonly settings: SettingsService,
    config: ConfigService<Env, true>,
    @Optional() @Inject(DELIVERY_FETCH) fetchFn?: typeof fetch,
  ) {
    this.gateway = config
      .get('SUITE_GATEWAY_INTERNAL_URL', { infer: true })
      .replace(/\/+$/, '');
    this.fetchFn = fetchFn ?? fetch;
  }

  @Interval(DELIVERY_INTERVAL_MS)
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tick();
    } catch (error) {
      this.logger.error(
        `Delivery worker failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      reportJobFailure('delivery-worker', error);
    } finally {
      this.running = false;
    }
  }

  /** One pass. Exposed for tests and for a manual nudge. */
  async tick(now: () => Date = () => new Date()): Promise<TickResult> {
    const claimed = await this.store.claim(now());
    const result: TickResult = { claimed: claimed.length, sent: 0, failed: 0 };
    let next = 0;
    const lane = async () => {
      while (next < claimed.length) {
        const row = claimed[next++];
        const status = await this.deliver(row, now);
        if (status === 'SENT') result.sent += 1;
        if (status === 'FAILED') result.failed += 1;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SEND_CONCURRENCY, claimed.length) }, lane),
    );
    return result;
  }

  private async deliver(row: ClaimedDelivery, now: () => Date) {
    const route = KIND_ROUTES[row.kind];
    let payload: Record<string, unknown> = row.payload;
    let version: SentVersion | undefined;
    if (route.versionColumn && row.repairTicketId) {
      const column = route.versionColumn;
      const eventVersion =
        (await this.store.eventVersion(row.repairTicketId, column)) + 1;
      payload = { ...payload, eventVersion };
      version = { repairTicketId: row.repairTicketId, eventVersion, column };
    }
    const outcome = await this.send(route, payload);
    const at = now();
    const update = nextState(
      outcome,
      row,
      at,
      this.settings.get('integration.retryWindowHours'),
    );
    await this.store.settle(row.id, update, at, version);
    if (update.status === 'FAILED') {
      this.logger.warn(
        `Delivery ${row.id} (${row.kind}) failed: ${update.lastStatusCode ?? 'no answer'} ${update.lastError}`,
      );
    }
    return update.status;
  }

  private async send(
    route: KindRoute,
    payload: Record<string, unknown>,
  ): Promise<SendOutcome> {
    const client = this.tokens.for(route.audience, route.scope);
    let token: string;
    try {
      token = await client.token();
    } catch (error) {
      return { kind: 'no_answer', error: errorFromThrown(error) };
    }
    try {
      const response = await this.fetchFn(`${this.gateway}${route.path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const body = await response.text().catch(() => '');
      // The other system no longer takes this token (a key change): fetch a fresh one next time
      if (response.status === 401) client.drop();
      return {
        kind: 'answer',
        status: response.status,
        error: response.ok ? null : errorFromBody(body),
      };
    } catch (error) {
      return { kind: 'no_answer', error: errorFromThrown(error) };
    }
  }
}
