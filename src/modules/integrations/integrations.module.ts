import {
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import SharedModule from '../../shared/shared.module';
import { DeliveryStore } from './deliveries/delivery-store';
import { DeliveryWorker } from './deliveries/delivery-worker';
import { FleetLinkService } from './fleet/fleet-link.service';
import { FleetReconcileJob } from './fleet/fleet-reconcile.job';
import { FleetSyncService } from './fleet/fleet-sync.service';
import { VmmsFleetClient } from './fleet/vmms-fleet.client';
import { NoStoreMiddleware } from './no-store.middleware';
import { ReferralIntakeService } from './referrals/referral-intake.service';
import { ReferralsController } from './referrals/referrals.controller';
import { ReferralsService } from './referrals/referrals.service';
import { VmmsIntegrationsController } from './vmms-integrations.controller';
import { ServiceTokens } from './service-tokens';

/**
 * Spec 0029: VRMS's integration with VMMS and BMS. Inbound routes live under
 * `/vrms/integrations/*` and take only `@ServiceRoute()` service tokens; outbound messages go
 * through the outbox (`enqueueDelivery`) and `DeliveryWorker`.
 */
@Module({
  imports: [SharedModule],
  controllers: [VmmsIntegrationsController, ReferralsController],
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
  ],
  exports: [ServiceTokens, VmmsFleetClient],
})
export class IntegrationsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(NoStoreMiddleware).forRoutes({
      path: 'vrms/integrations/*path',
      method: RequestMethod.ALL,
    });
  }
}
