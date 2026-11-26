import { Module } from '@nestjs/common';
import SharedModule from '../../shared/shared.module';
import { AiModule } from '../ai/ai.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { RepairsController } from './repairs.controller';
import { RepairsService } from './repairs.service';
import { TicketEditsService } from './ticket-edits.service';
import { ChecklistEditsService } from './checklist-edits.service';
import { ConfigController } from './config/config.controller';
import { ConfigService } from './config/config.service';
import { LookupsController } from './lookups/lookups.controller';
import { LookupsService } from './lookups/lookups.service';
import { VehiclesController } from './vehicles/vehicles.controller';
import { VehiclesService } from './vehicles/vehicles.service';
import { MechanicRoster } from './mechanic-roster.service';
import { AuthDirectoryClient } from './directory/auth-directory.client';
import { DirectorySync } from './directory/directory-sync.service';
import { DirectoryPollJob } from './directory/directory-poll.job';
import { PeopleCopy } from './directory/people-copy';
import { MechanicWorkService } from './mechanic-work.service';
import { ReferralDecisionsController } from './referral-decisions.controller';
import { ReferralDecisionsService } from './referral-decisions.service';

@Module({
  // IntegrationsModule: the VMMS fleet client for ticket create's fresh read (spec 0029, AC-5)
  imports: [SharedModule, AiModule, IntegrationsModule],
  controllers: [
    RepairsController,
    ConfigController,
    LookupsController,
    VehiclesController,
    ReferralDecisionsController,
  ],
  providers: [
    RepairsService,
    TicketEditsService,
    ChecklistEditsService,
    ConfigService,
    LookupsService,
    VehiclesService,
    MechanicRoster,
    AuthDirectoryClient,
    DirectorySync,
    DirectoryPollJob,
    PeopleCopy,
    MechanicWorkService,
    ReferralDecisionsService,
  ],
})
export class VrmsModule {}
