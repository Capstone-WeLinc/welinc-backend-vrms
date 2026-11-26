import {
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import SharedModule from '../../shared/shared.module';
import { DeliveryStore } from './deliveries/delivery-store';
import { DeliveryWorker } from './deliveries/delivery-worker';
import { NoStoreMiddleware } from './no-store.middleware';
import { ServiceTokens } from './service-tokens';

/**
 * Spec 0029: VRMS's integration with VMMS and BMS. Inbound routes live under
 * `/vrms/integrations/*` and take only `@ServiceRoute()` service tokens; outbound messages go
 * through the outbox (`enqueueDelivery`) and `DeliveryWorker`.
 */
@Module({
  imports: [SharedModule],
  providers: [ServiceTokens, DeliveryStore, DeliveryWorker],
  exports: [ServiceTokens],
})
export class IntegrationsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(NoStoreMiddleware).forRoutes({
      path: 'vrms/integrations/*path',
      method: RequestMethod.ALL,
    });
  }
}
