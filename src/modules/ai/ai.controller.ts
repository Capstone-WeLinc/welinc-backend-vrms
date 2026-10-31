import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { AuthUser } from '../../auth/account-check';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { CurrentAbility } from '../../auth/permissions/current-ability.decorator';
import { RequirePermission } from '../../auth/permissions/permission.decorators';
import { DiagnosisService } from './diagnosis.service';
import { DiagnosisFeedbackDto } from './dto/diagnosis-feedback.dto';

type AuthRequest = { user: AuthUser };

// Spec 0013, API surface. ai.use belongs to module ai, so the guard answers MODULE_DISABLED
// while AI is off (AC-17); ticket access comes from the ability.
@Controller('vrms/ai')
export class AiController {
  constructor(private readonly diagnoses: DiagnosisService) {}

  @RequirePermission('ai.use')
  @Post('tickets/:ticketId/diagnoses')
  @HttpCode(201)
  run(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.diagnoses.run(ticketId, req.user, ability);
  }

  @RequirePermission('ai.use')
  @Get('tickets/:ticketId/diagnoses/latest')
  latest(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.diagnoses.latest(ticketId, ability);
  }

  @RequirePermission('ai.use')
  @Put('diagnoses/:id/feedback')
  feedback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DiagnosisFeedbackDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.diagnoses.saveFeedback(id, dto, req.user, ability);
  }

  // Shown on the Analytics page, so analytics.view opens it; the service checks the AI switch
  @RequirePermission('analytics.view')
  @Get('stats')
  stats() {
    return this.diagnoses.stats();
  }
}
