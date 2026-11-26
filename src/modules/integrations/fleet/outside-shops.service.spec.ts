import { ServiceUnavailableException } from '@nestjs/common';
import {
  OutsideShopsService,
  SHOP_LIST_TTL_MS,
  STUB_SHOPS,
} from './outside-shops.service';
import { FakeFleet } from './vmms-fleet.fake';

// Spec 0029 (child 0002), AC-36: the outside shop list, kept for 24 hours.

const SHOP = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  name: 'Pampanga Truck Care',
};

describe('OutsideShopsService (AC-36)', () => {
  it("answers VMMS's list, and the stub while VMMS doesn't serve the route (404, ask 6)", async () => {
    const fleet = new FakeFleet();
    fleet.shops = [SHOP];
    const service = new OutsideShopsService(fleet.asClient());
    await expect(service.list()).resolves.toEqual({
      shops: [SHOP],
      stale: false,
    });
    fleet.shops = null;
    await expect(service.list()).resolves.toEqual({
      shops: STUB_SHOPS,
      stale: false,
    });
  });

  it('answers the last list as stale within 24 hours of reading it, then 503', async () => {
    const fleet = new FakeFleet();
    fleet.shops = [SHOP];
    const service = new OutsideShopsService(fleet.asClient());
    await service.list(1_000);
    fleet.shops = 'unavailable';
    await expect(service.list(1_000 + SHOP_LIST_TTL_MS - 1)).resolves.toEqual({
      shops: [SHOP],
      stale: true,
    });
    await expect(service.list(1_000 + SHOP_LIST_TTL_MS)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('answers 503 VMMS_UNAVAILABLE when VMMS is down and no list was ever read', async () => {
    const fleet = new FakeFleet();
    fleet.shops = 'unavailable';
    await expect(
      new OutsideShopsService(fleet.asClient()).list(),
    ).rejects.toMatchObject({
      response: { code: 'VMMS_UNAVAILABLE' },
    });
  });
});
