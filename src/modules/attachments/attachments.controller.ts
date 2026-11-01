import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { AuthUser } from '../../auth/account-check';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { CurrentAbility } from '../../auth/permissions/current-ability.decorator';
import { Authenticated } from '../../auth/permissions/permission.decorators';
import { AttachmentsService } from './attachments.service';
import { UploadAttachmentDto } from './dto/upload-attachment.dto';

type AuthRequest = { user: AuthUser };

/** AC-5: the hard cap multer holds in memory; the setting is checked after. */
export const MULTER_MAX_BYTES = 25 * 1024 * 1024 + 1;

// Spec 0017, API surface. The add right depends on the kind, so the service checks it (AC-15).
@Controller('vrms/repairs/:id/attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Authenticated()
  @Get()
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.attachments.list(id, ability);
  }

  @Authenticated()
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MULTER_MAX_BYTES, files: 1, fields: 5 },
    }),
  )
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
