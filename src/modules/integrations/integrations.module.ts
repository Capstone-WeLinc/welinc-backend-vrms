import {
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import SharedModule from '../../shared/shared.module';
import { BmsIntegrationsController } from './bms/bms-integrations.controller';
import { BmsRepairReadsService } from './bms/bms-repair-reads.service';
import { BmsScheduleClient } from './bms/bms-schedule.client';
import { ExpediteIntakeService } from './bms/expedite-intake.service';
import { UpcomingTripsService } from './bms/upcoming-trips.service';
import { DeliveriesController } from './deliveries/deliveries.controller';
import { DeliveriesService } from './deliveries/deliveries.service';
import { DeliveryRetentionJob } from './deliveries/delivery-retention.job';
import { DeliveryStore } from './deliveries/delivery-store';
import { DeliveryWorker } from './deliveries/delivery-worker';
import { FleetLinkService } from './fleet/fleet-link.service';
import { FleetReconcileJob } from './fleet/fleet-reconcile.job';
import { FleetSyncService } from './fleet/fleet-sync.service';
import { OutsideShopsService } from './fleet/outside-shops.service';
import { VmmsFleetClient } from './fleet/vmms-fleet.client';
import { NoStoreMiddleware } from './no-store.middleware';
import { ReferralIntakeService } from './referrals/referral-intake.service';
import { ReferralsController } from './referrals/referrals.controller';
import { ReferralsService } from './referrals/referrals.service';
import { VmmsIntegrationsController } from './vmms-integrations.controller';
import { ServiceTokens } from './service-tokens';
import { VmmsRepairReadsService } from './vmms-repair-reads.service';

/**
 * Spec 0029: VRMS's integration with VMMS and BMS. Inbound routes live under
 * `/vrms/integrations/*` and take only `@ServiceRoute()` service tokens; outbound messages go
 * through the outbox (`enqueueDelivery`) and `DeliveryWorker`.
 */
@Module({
  imports: [SharedModule],
  controllers: [
    VmmsIntegrationsController,
    BmsIntegrationsController,
    ReferralsController,
    DeliveriesController,
  ],
  providers: [
    ReferralIntakeService,
    ReferralsService,
    ServiceTokens,
    DeliveryStore,
    DeliveryWorker,
    VmmsFleetClient,
    FleetLinkService,
    FleetSyncService,
    FleetReconcileJob,
    VmmsRepairReadsService,
    OutsideShopsService,
    DeliveriesService,
    DeliveryRetentionJob,
    BmsScheduleClient,
    UpcomingTripsService,
    ExpediteIntakeService,
    BmsRepairReadsService,
  ],
  exports: [
    ServiceTokens,
    VmmsFleetClient,
    ReferralsService,
    OutsideShopsService,
    UpcomingTripsService,
  ],
})
export class IntegrationsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(NoStoreMiddleware).forRoutes({
      path: 'vrms/integrations/*path',
      method: RequestMethod.ALL,
    });
  }
}
