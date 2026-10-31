import { Controller, Get } from '@nestjs/common';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { CurrentAbility } from '../../auth/permissions/current-ability.decorator';
import { RequirePermission } from '../../auth/permissions/permission.decorators';
import { AnalyticsService } from './analytics.service';

// Spec 0013, AC-3 and AC-5: analytics.view opens every route (module analytics); peso fields
// also need ticket.costs.view.
@Controller('vrms/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @RequirePermission('analytics.view')
  @Get('summary')
  summary(@CurrentAbility() ability: AppAbility) {
    return this.analytics.summary(ability);
  }

  @RequirePermission('analytics.view')
  @Get('cost-trends')
  costTrends(@CurrentAbility() ability: AppAbility) {
    return this.analytics.costTrends(ability);
  }

  @RequirePermission('analytics.view')
  @Get('vehicle-kpis')
  vehicleKpis(@CurrentAbility() ability: AppAbility) {
    return this.analytics.vehicleKpis(ability);
  }

  @RequirePermission('analytics.view')
  @Get('issue-frequency')
  issueFrequency() {
    return this.analytics.issueFrequency();
  }

  @RequirePermission('analytics.view')
  @Get('status-breakdown')
  statusBreakdown() {
    return this.analytics.statusBreakdown();
  }

  @RequirePermission('analytics.view')
  @Get('garage-costs')
  garageCosts(@CurrentAbility() ability: AppAbility) {
    return this.analytics.garageCosts(ability);
  }

  @RequirePermission('analytics.view')
  @Get('aging')
  aging() {
    return this.analytics.aging();
  }

  @RequirePermission('analytics.view')
  @Get('velocity')
  velocity() {
    return this.analytics.velocity();
  }
}
