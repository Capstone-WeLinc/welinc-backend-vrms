import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  FleetUnavailableError,
  VmmsFleetClient,
  type OutsideShop,
} from './vmms-fleet.client';

// Spec 0029 (child 0002), AC-36: the outside shop picker reads VMMS's active shop list. The last
// good list is kept in memory for 24 hours and answered as stale when VMMS can't be reached.

export const SHOP_LIST_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Until VMMS serves `GET /vmms/fleet/outsourced-providers` (ask 6), a 404 answers this list, with
 * fixed ids, so the picker and the stored shop work end to end. VMMS reads only the shop's name
 * from repair events, so a stub id never reaches it. Remove once ask 6 lands.
 */
export const STUB_SHOPS: OutsideShop[] = [
  { id: '6f1c2a8e-4b1d-4c55-9a51-0c3e7b9d1a01', name: 'Bulacan Diesel Works' },
  {
    id: '6f1c2a8e-4b1d-4c55-9a51-0c3e7b9d1a02',
    name: 'Laguna Truck Body and Paint',
  },
  {
    id: '6f1c2a8e-4b1d-4c55-9a51-0c3e7b9d1a03',
    name: 'Marikina Brake and Clutch Center',
  },
  {
    id: '6f1c2a8e-4b1d-4c55-9a51-0c3e7b9d1a04',
    name: 'Valenzuela Fuel Injection Services',
  },
];

export type ShopList = { shops: OutsideShop[]; stale: boolean };

@Injectable()
export class OutsideShopsService {
  private readonly logger = new Logger(OutsideShopsService.name);
  private last: { shops: OutsideShop[]; at: number } | null = null;

  constructor(private readonly fleet: VmmsFleetClient) {}

  /** The list for the picker, or 503 `VMMS_UNAVAILABLE` when VMMS is down and none is kept. */
  async list(now = Date.now()): Promise<ShopList> {
    try {
      const fromVmms = await this.fleet.outsideShops();
      const shops = fromVmms ?? STUB_SHOPS;
      this.last = { shops, at: now };
      return { shops, stale: false };
    } catch (error) {
      if (!(error instanceof FleetUnavailableError)) throw error;
      this.logger.warn(`Outside shop list: ${error.reason}`);
      if (this.last && now - this.last.at < SHOP_LIST_TTL_MS) {
        return { shops: this.last.shops, stale: true };
      }
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'VMMS_UNAVAILABLE',
        message: "VMMS can't be reached, try again.",
      });
    }
  }

  /** The shop with this id in the current (or kept) list, or null. */
  async find(id: string): Promise<OutsideShop | null> {
    const { shops } = await this.list();
    return shops.find((s) => s.id === id) ?? null;
  }
}
