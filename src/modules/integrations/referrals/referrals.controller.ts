import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { RequirePermission } from '../../../auth/permissions/permission.decorators';
import {
  ApiErrors,
  ApiGenericErrors,
  ApiUserToken,
} from '../../../openapi/decorators';
import { ReferralsService } from './referrals.service';

export class ReferralListQueryDto {
  @IsOptional()
  @IsEnum(['WAITING', 'OPENED_TICKET', 'ADDED_TO_TICKET', 'REJECTED'])
  status?: 'WAITING' | 'OPENED_TICKET' | 'ADDED_TO_TICKET' | 'REJECTED';

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Spec 0029, AC-7 and AC-11: the Referrals tab on the Repairs page. */
@ApiTags('Referrals')
@ApiUserToken()
@ApiGenericErrors()
@Controller('vrms/referrals')
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @RequirePermission('integration.respond')
  @Get()
  list(@Query() query: ReferralListQueryDto) {
    return this.referrals.list(query);
  }

  @ApiErrors(404, ['REFERRAL_NOT_FOUND'])
  @RequirePermission('integration.respond')
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.referrals.detail(id);
  }
}
