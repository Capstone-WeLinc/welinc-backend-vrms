import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ServiceRoute } from '../../auth/verify';
import {
  ApiErrors,
  ApiGenericErrors,
  ApiServiceToken,
} from '../../openapi/decorators';
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
@ApiGenericErrors()
@Controller('vrms/integrations/vmms')
export class VmmsIntegrationsController {
  constructor(private readonly referrals: ReferralIntakeService) {}

  /** AC-6: a repair referral from a VMMS inspection that ended For Repair. */
  @ApiAcceptedResponse({ type: ReferralAcceptedView })
  @ApiErrors(400, [null, 'IDEMPOTENCY_KEY_MISMATCH'])
  @ApiErrors(403, ['WRONG_TOKEN_USE', 'FORBIDDEN'])
  @ApiErrors(409, ['REFERRAL_ID_REUSED'])
  @ApiErrors(422, ['VEHICLE_NOT_FOUND'])
  @ApiErrors(503, ['VMMS_UNAVAILABLE', 'AUTH_UNAVAILABLE'])
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
}
