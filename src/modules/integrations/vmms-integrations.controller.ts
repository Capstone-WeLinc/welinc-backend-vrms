import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ServiceRoute } from '../../auth/verify';
import { ApiErrorMap, ApiServiceToken } from '../../openapi/decorators';
import {
  FleetChangeAcceptedView,
  FleetChangeDto,
} from './fleet/fleet-change.dto';
import { FleetSyncService } from './fleet/fleet-sync.service';
import {
  RepairHistoryQueryDto,
  RepairHistoryResponse,
  RepairStatusView,
} from './vmms-repair-reads.dto';
import { VmmsRepairReadsService } from './vmms-repair-reads.service';
import { SERVICE_ROUTE_ERRORS, VALIDATION_ERROR } from './service-route-errors';
import { ReferralIntakeService } from './referrals/referral-intake.service';
import {
  ReferralAcceptedView,
  RepairReferralDto,
} from './referrals/repair-referral.dto';

/**
 * Spec 0029: the routes VMMS calls. Service tokens from client `vmms` only (AC-24); every answer
 * is `no-store` (`NoStoreMiddleware`).
 */
@ApiTags('Integrations: VMMS')
@ApiServiceToken()
@Controller('vrms/integrations/vmms')
export class VmmsIntegrationsController {
  constructor(
    private readonly referrals: ReferralIntakeService,
    private readonly fleetSync: FleetSyncService,
    private readonly reads: VmmsRepairReadsService,
  ) {}

  /** AC-14: one ticket's status as VMMS maps it, with the outside shop while outsourced. */
  @ApiOkResponse({ type: RepairStatusView })
  @ApiErrorMap(SERVICE_ROUTE_ERRORS, VALIDATION_ERROR, {
    404: ['REPAIR_NOT_FOUND'],
  })
  @ServiceRoute('repair.status.read', { clients: ['vmms'] })
  @Get('repairs/:repairTicketId')
  repairStatus(@Param('repairTicketId', ParseUUIDPipe) repairTicketId: string) {
    return this.reads.status(repairTicketId);
  }

  /** AC-15: a truck's repairs, newest first, never cancelled ones and never part prices. */
  @ApiOkResponse({ type: RepairHistoryResponse })
  @ApiErrorMap(SERVICE_ROUTE_ERRORS, { 400: [null, 'INVALID_CURSOR'] })
  @ServiceRoute('repair.history.read', { clients: ['vmms'] })
  @Get('vehicles/:vmmsVehicleId/repair-history')
  repairHistory(
    @Param('vmmsVehicleId', ParseUUIDPipe) vmmsVehicleId: string,
    @Query() query: RepairHistoryQueryDto,
  ) {
    return this.reads.history(vmmsVehicleId, query.limit, query.cursor);
  }

  /** AC-6: a repair referral from a VMMS inspection that ended For Repair. */
  @ApiAcceptedResponse({ type: ReferralAcceptedView })
  @ApiErrorMap(SERVICE_ROUTE_ERRORS, {
    400: [null, 'IDEMPOTENCY_KEY_MISMATCH'],
    409: ['REFERRAL_ID_REUSED'],
    422: ['VEHICLE_NOT_FOUND'],
    503: ['VMMS_UNAVAILABLE'],
  })
  @ServiceRoute('repair.referral.write', { clients: ['vmms'] })
  @HttpCode(202)
  @Post('repair-referrals')
  receiveReferral(
    @Body() dto: RepairReferralDto,
    @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && idempotencyKey !== dto.referralId) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'IDEMPOTENCY_KEY_MISMATCH',
        message: 'Idempotency-Key must equal referralId.',
      });
    }
    // The hash is over the body as received, before validation trimmed or cut anything
    return this.referrals.receive(dto, request.body);
  }

  /**
   * AC-2: VMMS says a truck or garage changed. Answered at once; VRMS then reads the record fresh
   * from VMMS's fleet API and applies it. The body is never trusted for field values.
   */
  @ApiAcceptedResponse({ type: FleetChangeAcceptedView })
  @ApiErrorMap(SERVICE_ROUTE_ERRORS, VALIDATION_ERROR)
  @ServiceRoute('fleet.change.write', { clients: ['vmms'] })
  @HttpCode(202)
  @Post('fleet-changes')
  receiveFleetChange(@Body() dto: FleetChangeDto): FleetChangeAcceptedView {
    this.fleetSync.receive(dto);
    return { accepted: true };
  }
}
