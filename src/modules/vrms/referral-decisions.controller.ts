import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../auth/account-check';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { CurrentAbility } from '../../auth/permissions/current-ability.decorator';
import { RequirePermission } from '../../auth/permissions/permission.decorators';
import {
  ApiErrors,
  ApiGenericErrors,
  ApiUserToken,
} from '../../openapi/decorators';
import {
  AddReferralToTicketDto,
  RejectReferralDto,
} from './dto/referral-decisions.dto';
import { ReferralDecisionsService } from './referral-decisions.service';
import { TicketDetailResponse } from './repairs.response';

type AuthRequest = { user: AuthUser };

/**
 * Spec 0029, AC-9 to AC-11: adding a VMMS referral to the truck's open ticket, or sending it
 * back. The reads of the Referrals tab live in the integrations module (`ReferralsController`).
 */
@ApiTags('Referrals')
@ApiUserToken()
@ApiGenericErrors()
@Controller('vrms/referrals')
export class ReferralDecisionsController {
  constructor(private readonly decisions: ReferralDecisionsService) {}

  @ApiOkResponse({ type: TicketDetailResponse })
  @ApiErrors(400, [null])
  @ApiErrors(404, ['REFERRAL_NOT_FOUND'])
  @ApiErrors(409, ['REFERRAL_ALREADY_DECIDED', 'NO_OPEN_TICKET', 'STALE'])
  @RequirePermission('integration.respond')
  @Post(':id/add-to-ticket')
  addToTicket(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddReferralToTicketDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.decisions.addToTicket(id, dto, req.user, ability);
  }

  @ApiErrors(400, [null])
  @ApiErrors(404, ['REFERRAL_NOT_FOUND'])
  @ApiErrors(409, ['REFERRAL_ALREADY_DECIDED'])
  @RequirePermission('integration.respond')
  @Post(':id/reject')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectReferralDto,
    @Req() req: AuthRequest,
  ) {
    return this.decisions.reject(id, dto, req.user);
  }
}
