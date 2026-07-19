import { Module } from '@nestjs/common';
import SharedModule from '../../shared/shared.module';
import { RepairsController } from './repairs.controller';
import { RepairsService } from './repairs.service';
import { ConfigController } from './config/config.controller';
import { ConfigService } from './config/config.service';

@Module({
  imports: [SharedModule],
  controllers: [RepairsController, ConfigController],
  providers: [RepairsService, ConfigService],
})
export class VrmsModule {}
