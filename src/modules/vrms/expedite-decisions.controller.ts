import {
  Body,
  Controller,
  Get,
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
  AcceptExpediteDto,
  DeclineExpediteDto,
  ExpediteRequestListResponse,
} from './dto/expedite-decisions.dto';
import { ExpediteDecisionsService } from './expedite-decisions.service';
import { TicketDetailResponse } from './repairs.response';

type AuthRequest = { user: AuthUser };

/**
 * Spec 0029 (child 0003), AC-18 and AC-19: BMS's waiting expedite requests, and a person's answer
 * to one. BMS's own route to send them is in the integrations module.
 */
@ApiTags('Expedite requests')
@ApiUserToken()
@ApiGenericErrors()
@Controller('vrms/expedite-requests')
export class ExpediteDecisionsController {
  constructor(private readonly decisions: ExpediteDecisionsService) {}

  @ApiOkResponse({ type: ExpediteRequestListResponse })
  @RequirePermission('integration.respond')
  @Get()
  list() {
    return this.decisions.listWaiting();
  }

  @ApiOkResponse({ type: TicketDetailResponse })
  @ApiErrors(400, [null])
  @ApiErrors(404, ['EXPEDITE_NOT_FOUND'])
  @ApiErrors(409, ['EXPEDITE_ALREADY_DECIDED', 'STALE'])
  @RequirePermission('integration.respond')
  @Post(':id/accept')
  accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptExpediteDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.decisions.accept(id, dto, req.user, ability);
  }

  @ApiOkResponse({ type: TicketDetailResponse })
  @ApiErrors(400, [null])
  @ApiErrors(404, ['EXPEDITE_NOT_FOUND'])
  @ApiErrors(409, ['EXPEDITE_ALREADY_DECIDED'])
  @RequirePermission('integration.respond')
  @Post(':id/decline')
  decline(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeclineExpediteDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.decisions.decline(id, dto, req.user, ability);
  }
}
