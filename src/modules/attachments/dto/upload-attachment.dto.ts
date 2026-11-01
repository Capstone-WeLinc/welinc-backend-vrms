import { AttachmentKind } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

// Spec 0017, AC-4 and AC-11: the multipart fields beside `file`.
export class UploadAttachmentDto {
  @IsEnum(AttachmentKind)
  kind: AttachmentKind;

  @IsOptional()
  @IsUUID()
  issueId?: string;
}
