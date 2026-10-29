import { Module } from '@nestjs/common';
import SharedModule from '../../shared/shared.module';
import { RepairsController } from './repairs.controller';
import { RepairsService } from './repairs.service';
import { ConfigController } from './config/config.controller';
import { ConfigService } from './config/config.service';
import { MechanicRoster } from './mechanic-roster.service';
import { MechanicWorkService } from './mechanic-work.service';

@Module({
  imports: [SharedModule],
  controllers: [RepairsController, ConfigController],
  providers: [
    RepairsService,
    ConfigService,
    MechanicRoster,
    MechanicWorkService,
  ],
})
export class VrmsModule {}
