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
  Req,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ServiceRoute } from '../../../auth/verify';
import { ApiErrorMap, ApiServiceToken } from '../../../openapi/decorators';
import {
  SERVICE_ROUTE_ERRORS,
  VALIDATION_ERROR,
} from '../service-route-errors';
import {
  ActiveRepairResponse,
  ExpediteAcceptedView,
  ExpediteRequestDto,
} from './bms-integration.dto';
import { BmsRepairReadsService } from './bms-repair-reads.service';
import { ExpediteIntakeService } from './expedite-intake.service';

/**
 * Spec 0029 (child 0003): the routes BMS calls. Service tokens from client `bms` only (AC-24);
 * every answer is `no-store` (`NoStoreMiddleware`).
 */
@ApiTags('Integrations: BMS')
@ApiServiceToken()
@Controller('vrms/integrations/bms')
export class BmsIntegrationsController {
  constructor(
    private readonly expedites: ExpediteIntakeService,
    private readonly reads: BmsRepairReadsService,
  ) {}

  /** AC-18: BMS asks VRMS to hurry the truck's open repair for one Job Order. */
  @ApiAcceptedResponse({ type: ExpediteAcceptedView })
  @ApiErrorMap(SERVICE_ROUTE_ERRORS, {
    400: [null, 'IDEMPOTENCY_KEY_MISMATCH'],
    404: ['NO_OPEN_REPAIR'],
    409: ['REQUEST_ID_REUSED'],
  })
  @ServiceRoute('repair.expedite.write', { clients: ['bms'] })
  @HttpCode(202)
  @Post('expedite-requests')
  receiveExpedite(
    @Body() dto: ExpediteRequestDto,
    @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && idempotencyKey !== dto.requestId) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'IDEMPOTENCY_KEY_MISMATCH',
        message: 'Idempotency-Key must equal requestId.',
      });
    }
    // The hash is over the body as received, before validation trimmed anything
    return this.expedites.receive(dto, request.body);
  }

  /** AC-20: the truck's open repair, or `{ repair: null }`. Never costs, notes or people. */
  @ApiOkResponse({ type: ActiveRepairResponse })
  @ApiErrorMap(SERVICE_ROUTE_ERRORS, VALIDATION_ERROR)
  @ServiceRoute('repair.status.read', { clients: ['bms'] })
  @Get('vehicles/:vmmsVehicleId/active-repair')
  activeRepair(@Param('vmmsVehicleId', ParseUUIDPipe) vmmsVehicleId: string) {
    return this.reads.activeRepair(vmmsVehicleId);
  }
}
