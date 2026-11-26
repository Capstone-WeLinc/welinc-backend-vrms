import {
  FleetUnavailableError,
  type FleetGarage,
  type FleetVehicle,
  type OutsideShop,
  type VmmsFleetClient,
} from './vmms-fleet.client';

/**
 * For services that read VMMS's fleet API. By default VMMS can't be reached, so ticket create
 * goes on with the local copy (spec 0029, AC-5) and touches nothing else. Set `truck` to answer a
 * fresh record, or null for a 404.
 */
export class FakeFleet {
  truck: FleetVehicle | null | 'unavailable' = 'unavailable';
  garageList: FleetGarage[] = [];
  vehicleList: FleetVehicle[] = [];
  /** The outside shops VMMS answers, null for its 404, or 'unavailable'. */
  shops: OutsideShop[] | null | 'unavailable' = [];
  readonly reads: string[] = [];

  vehicle(id: string): Promise<FleetVehicle | null> {
    this.reads.push(id);
    if (this.truck === 'unavailable') {
      return Promise.reject(new FleetUnavailableError('HTTP 502'));
    }
    return Promise.resolve(this.truck);
  }

  vehicles(): Promise<FleetVehicle[]> {
    return Promise.resolve(this.vehicleList);
  }

  garages(): Promise<FleetGarage[]> {
    return Promise.resolve(this.garageList);
  }

  outsideShops(): Promise<OutsideShop[] | null> {
    if (this.shops === 'unavailable') {
      return Promise.reject(new FleetUnavailableError('HTTP 502'));
    }
    return Promise.resolve(this.shops);
  }

  asClient(): VmmsFleetClient {
    return this as unknown as VmmsFleetClient;
  }
}
