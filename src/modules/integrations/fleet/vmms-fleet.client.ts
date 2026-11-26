import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env';
import { ServiceTokens } from '../service-tokens';

/** VMMS's `FleetVehicle` (docs/integration/fleet-api.md). */
export type FleetVehicle = {
  id: string;
  plateNumber: string;
  make: string | null;
  model: string;
  year: number | null;
  truckSizeCategory: string | null;
  capacity: number;
  odometer: number;
  status: 'AVAILABLE' | 'UNDER_REPAIR' | 'UNDER_MAINTENANCE';
  garageId: string | null;
  updatedAt: string;
};

export type FleetGarage = { id: string; name: string };

/** VMMS answered with something other than the record, or not at all (timeout, network, 5xx). */
export class FleetUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`VMMS fleet API unavailable: ${reason}`);
    this.name = 'FleetUnavailableError';
  }
}

/** Ticket create waits this long for the fresh read before it uses the copy (child 0001). */
export const FRESH_READ_TIMEOUT_MS = 3_000;
/** The full lists for the reconcile and `fleet:link`. */
export const LIST_TIMEOUT_MS = 15_000;

/** Tests pass their own fetch; the app uses the global one. */
export const FLEET_FETCH = Symbol('FLEET_FETCH');

/**
 * Spec 0029 (child 0001): the only reader of VMMS's fleet API, through the suite gateway with
 * VRMS's `fleet.read` service token. A 401 drops the kept token and tries once more.
 */
@Injectable()
export class VmmsFleetClient {
  private readonly gateway: string;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly tokens: ServiceTokens,
    config: ConfigService<Env, true>,
    @Optional() @Inject(FLEET_FETCH) fetchFn?: typeof fetch,
  ) {
    this.gateway = config
      .get('SUITE_GATEWAY_INTERNAL_URL', { infer: true })
      .replace(/\/+$/, '');
    this.fetchFn = fetchFn ?? fetch;
  }

  async vehicles(): Promise<FleetVehicle[]> {
    const body = await this.get<{ vehicles?: FleetVehicle[] }>(
      '/vmms/fleet/vehicles',
      LIST_TIMEOUT_MS,
    );
    if (!body || !Array.isArray(body.vehicles)) {
      throw new FleetUnavailableError('vehicle list missing');
    }
    return body.vehicles;
  }

  async garages(): Promise<FleetGarage[]> {
    const body = await this.get<{ garages?: FleetGarage[] }>(
      '/vmms/fleet/garages',
      LIST_TIMEOUT_MS,
    );
    if (!body || !Array.isArray(body.garages)) {
      throw new FleetUnavailableError('garage list missing');
    }
    return body.garages;
  }

  /** One truck, read fresh; null when VMMS doesn't have it (404). */
  vehicle(
    id: string,
    timeoutMs = FRESH_READ_TIMEOUT_MS,
  ): Promise<FleetVehicle | null> {
    return this.get<FleetVehicle>(
      `/vmms/fleet/vehicles/${encodeURIComponent(id)}`,
      timeoutMs,
    );
  }

  /** The parsed body, null on 404, or `FleetUnavailableError` for anything else. */
  private async get<T>(path: string, timeoutMs: number): Promise<T | null> {
    const client = this.tokens.for('VMMS', 'fleet.read');
    for (let attempt = 0; ; attempt += 1) {
      let token: string;
      try {
        token = await client.token();
      } catch {
        throw new FleetUnavailableError('no service token');
      }
      let response: Response;
      try {
        response = await this.fetchFn(`${this.gateway}${path}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = (error as { name?: unknown } | null)?.name;
        throw new FleetUnavailableError(
          typeof name === 'string' ? name : 'network error',
        );
      }
      if (response.status === 401 && attempt === 0) {
        client.drop();
        continue;
      }
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new FleetUnavailableError(`HTTP ${response.status}`);
      }
      try {
        return (await response.json()) as T;
      } catch {
        throw new FleetUnavailableError('answer is not JSON');
      }
    }
  }
}
