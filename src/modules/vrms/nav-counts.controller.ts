import { Controller, Get, Header, Req } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../auth/account-check';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { CurrentAbility } from '../../auth/permissions/current-ability.decorator';
import { Authenticated } from '../../auth/permissions/permission.decorators';
import { ApiGenericErrors, ApiUserToken } from '../../openapi/decorators';
import { NavCountsService } from './nav-counts.service';

/** `GET /vrms/nav/counts`: each present only for a sub page the caller can see. */
export class NavCountsResponse {
  @ApiProperty({ required: false, description: 'All open (ticket.view_all)' })
  open?: number;

  @ApiProperty({
    required: false,
    description:
      'Waiting for sign off: For verification, minus tickets the caller is assigned to (ticket.view_all)',
  })
  signoff?: number;

  @ApiProperty({
    required: false,
    description:
      'Assigned to me: open tickets assigned to the caller (ticket.view_all and the roster)',
  })
  mine?: number;

  @ApiProperty({
    required: false,
    description:
      "In progress: the caller's Assigned, In progress or On hold tickets (ticket.view)",
  })
  active?: number;

  @ApiProperty({
    required: false,
    description:
      "Sent back to me: the caller's In progress tickets with a send back in force (ticket.view)",
  })
  sentBack?: number;

  @ApiProperty({
    required: false,
    description: 'Fix library suggestions waiting for review (knowledge.edit)',
  })
  suggestions?: number;
}

// VRMS spec 0027, AC-5 and AC-7: the sidebar's counts. Any signed in VRMS user may ask; each
// count is gated by its own key, so a user with no keys gets {}.
@ApiTags('Navigation')
@ApiUserToken()
@ApiGenericErrors()
@Controller('vrms/nav')
export class NavCountsController {
  constructor(private readonly navCounts: NavCountsService) {}

  @ApiOkResponse({ type: NavCountsResponse })
  @Authenticated()
  @Get('counts')
  @Header('Cache-Control', 'no-store')
  counts(
    @Req() req: { user: AuthUser },
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.navCounts.counts(req.user.sub, ability);
  }
}
