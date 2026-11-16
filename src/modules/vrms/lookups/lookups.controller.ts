import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { RequirePermission } from '../../../auth/permissions/permission.decorators';
import type { AuthUser } from '../../../auth/account-check';
import {
  CreateLookupValueDto,
  UpdateLookupValueDto,
} from '../dto/lookup-value.dto';
import { LookupsService } from './lookups.service';
import { ApiTags } from '@nestjs/swagger';
import { ApiGenericErrors, ApiUserToken } from '../../../openapi/decorators';

type AuthRequest = { user: AuthUser };

@ApiTags('Lookups')
@ApiUserToken()
@ApiGenericErrors()
@Controller('vrms/lookups')
export class LookupsController {
  constructor(private readonly lookups: LookupsService) {}

  // GET /vrms/lookups/:list (spec 0016, AC-19)
  @RequirePermission('config.read')
  @Get(':list')
  listActive(@Param('list') list: string) {
    return this.lookups.listActive(list);
  }

  // GET /vrms/lookups/:list/all, inactive values too, for the Settings editor
  @RequirePermission('lookups.manage')
  @Get(':list/all')
  listAll(@Param('list') list: string) {
    return this.lookups.listAll(list);
  }

  // POST /vrms/lookups/:list
  @RequirePermission('lookups.manage')
  @Post(':list')
  create(
    @Param('list') list: string,
    @Body() dto: CreateLookupValueDto,
    @Req() req: AuthRequest,
  ) {
    return this.lookups.create(list, dto, req.user);
  }

  // PATCH /vrms/lookups/:list/:id
  @RequirePermission('lookups.manage')
  @Patch(':list/:id')
  update(
    @Param('list') list: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLookupValueDto,
    @Req() req: AuthRequest,
  ) {
    return this.lookups.update(list, id, dto, req.user);
  }
}
