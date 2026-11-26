import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import type { AuthUser } from '../../../auth/account-check';
import { RequirePermission } from '../../../auth/permissions/permission.decorators';
import {
  ApiErrors,
  ApiGenericErrors,
  ApiUserToken,
} from '../../../openapi/decorators';
import { DeliveriesService } from './deliveries.service';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class DeliveryListQueryDto {
  @IsOptional()
  @IsEnum(['PENDING', 'SENT', 'FAILED', 'DISMISSED'])
  status?: 'PENDING' | 'SENT' | 'FAILED' | 'DISMISSED';

  @IsOptional()
  @IsEnum(['VMMS', 'BMS'])
  target?: 'VMMS' | 'BMS';

  @IsOptional()
  @IsEnum([
    'REPAIR_EVENT',
    'REFERRAL_REJECTED',
    'REPAIR_UPDATE',
    'EXPEDITE_ANSWER',
  ])
  kind?:
    'REPAIR_EVENT' | 'REFERRAL_REJECTED' | 'REPAIR_UPDATE' | 'EXPEDITE_ANSWER';

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

export class DismissDeliveryDto {
  @Transform(trim)
  @IsString()
  @Length(5, 500, { message: 'Say why, in 5 to 500 characters.' })
  reason: string;
}

type AuthRequest = { user: AuthUser };

/** Spec 0029, AC-22: every message VRMS sent or is still sending to VMMS and BMS. */
@ApiTags('Deliveries')
@ApiUserToken()
@ApiGenericErrors()
@Controller('vrms/deliveries')
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @ApiErrors(400, [null])
  @RequirePermission('audit.view')
  @Get()
  list(@Query() query: DeliveryListQueryDto) {
    return this.deliveries.list(query);
  }

  @ApiErrors(404, ['DELIVERY_NOT_FOUND'])
  @RequirePermission('audit.view')
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.deliveries.detail(id);
  }

  @ApiErrors(404, ['DELIVERY_NOT_FOUND'])
  @ApiErrors(409, ['NOT_FAILED'])
  @RequirePermission('integration.respond')
  @HttpCode(200)
  @Post(':id/retry')
  retry(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) {
    return this.deliveries.retry(id, req.user);
  }

  @ApiErrors(400, [null])
  @ApiErrors(404, ['DELIVERY_NOT_FOUND'])
  @ApiErrors(409, ['NOT_FAILED'])
  @RequirePermission('integration.respond')
  @HttpCode(200)
  @Post(':id/dismiss')
  dismiss(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DismissDeliveryDto,
    @Req() req: AuthRequest,
  ) {
    return this.deliveries.dismiss(id, dto.reason, req.user);
  }
}
