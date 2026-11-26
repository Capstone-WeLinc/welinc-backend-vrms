import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env';
import { ServiceTokens } from '../service-tokens';

/** One upcoming trip of a truck, as BMS answers it (child 0003). Schedule facts only. */
export type BmsTrip = {
  bookingNumber: string;
  jobOrderNumber: string | null;
  serviceDate: string; // YYYY-MM-DD, Asia/Manila
  dispatchTime: string | null; // HH:MM
  status: string;
};

/** The days ahead VRMS asks for (BMS takes 1 to 31). */
export const SCHEDULE_DAYS = 14;
/** The form and the ticket page wait this long, then say BMS can't be reached. */
export const SCHEDULE_TIMEOUT_MS = 3_000;

/** Tests pass their own fetch; the app uses the global one. */
export const BMS_FETCH = Symbol('BMS_FETCH');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/** Keeps the items that have the agreed shape, and only their agreed fields. */
export function parseTrips(body: unknown): BmsTrip[] | null {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  const trips: BmsTrip[] = [];
  for (const raw of items as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') continue;
    const { bookingNumber, jobOrderNumber, serviceDate, dispatchTime, status } =
      raw;
    if (
      typeof bookingNumber !== 'string' ||
      typeof serviceDate !== 'string' ||
      !DATE.test(serviceDate) ||
      typeof status !== 'string'
    ) {
      continue;
    }
    trips.push({
      bookingNumber,
      jobOrderNumber:
        typeof jobOrderNumber === 'string' ? jobOrderNumber : null,
      serviceDate,
      dispatchTime:
        typeof dispatchTime === 'string' && TIME.test(dispatchTime)
          ? dispatchTime
          : null,
      status,
    });
  }
  return trips;
}

/**
 * Spec 0029 (child 0003), AC-16: the only reader of BMS's schedule, through the suite gateway
 * with VRMS's `schedule.read` token. Answers the trips, or null for any failure (timeout,
 * network, no token, any non 2xx, a body of the wrong shape). Nothing is stored.
 */
@Injectable()
export class BmsScheduleClient {
  private readonly gateway: string;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly tokens: ServiceTokens,
    config: ConfigService<Env, true>,
    @Optional() @Inject(BMS_FETCH) fetchFn?: typeof fetch,
  ) {
    this.gateway = config
      .get('SUITE_GATEWAY_INTERNAL_URL', { infer: true })
      .replace(/\/+$/, '');
    this.fetchFn = fetchFn ?? fetch;
  }

  async upcomingTrips(vmmsVehicleId: string): Promise<BmsTrip[] | null> {
    const client = this.tokens.for('BMS', 'schedule.read');
    const deadline = AbortSignal.timeout(SCHEDULE_TIMEOUT_MS);
    const url = `${this.gateway}/bms/integrations/vrms/vehicles/${encodeURIComponent(vmmsVehicleId)}/schedule?days=${SCHEDULE_DAYS}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const token = await client.token();
        const response = await this.fetchFn(url, {
          headers: { authorization: `Bearer ${token}` },
          signal: deadline,
        });
        // A key change on BMS's side: one fresh token, within the same 3 s
        if (response.status === 401 && attempt === 0) {
          client.drop();
          continue;
        }
        if (!response.ok) return null;
        return parseTrips(await response.json());
      } catch {
        return null;
      }
    }
    return null;
  }
}
