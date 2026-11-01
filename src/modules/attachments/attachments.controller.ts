import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthUser } from '../../auth/account-check';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { CurrentAbility } from '../../auth/permissions/current-ability.decorator';
import { Authenticated } from '../../auth/permissions/permission.decorators';
import { UploadAccessGuard, UserThrottlerGuard } from './attachments.guard';
import { AttachmentsService } from './attachments.service';
import { UploadAttachmentDto } from './dto/upload-attachment.dto';
import { SingleFileInterceptor } from './upload.interceptor';

type AuthRequest = { user: AuthUser };

// Spec 0017, API surface. The add right depends on the kind, so the service checks it (AC-15).
@Controller('vrms/repairs/:id/attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Authenticated()
  @Get()
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.attachments.list(id, req.user, ability);
  }

  // AC-17: soft delete; the remove rule is checked in the service
  @Authenticated()
  @Delete(':attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.attachments.remove(id, attachmentId, req.user, ability);
  }

  // AC-12 and AC-12a: visibility (404), then the per user rate limit (429), and only then is the
  // body read into memory by the interceptor
  @Authenticated()
  @Post()
  @UseGuards(UploadAccessGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(SingleFileInterceptor)
  async upload(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadAttachmentDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { attachment, duplicate } = await this.attachments.upload(
      id,
      file,
      dto,
      req.user,
      ability,
    );
    // AC-8: a duplicate stores nothing and answers 200 with the existing file
    if (duplicate) {
      res.status(HttpStatus.OK);
      return { ...attachment, duplicate: true };
    }
    return attachment;
  }
}
