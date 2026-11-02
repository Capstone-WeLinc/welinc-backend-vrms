import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { UPLOAD_KINDS, type UploadKind } from '../attachment-kinds';

// Spec 0017, AC-4 and AC-11: the multipart fields beside `file`. Spec 0018: `PHOTO` lets the
// server pick Before or After; `VEHICLE_PHOTO` and `PROOF` are read as `PHOTO`.
export class UploadAttachmentDto {
  @IsIn(UPLOAD_KINDS)
  kind: UploadKind;

  @IsOptional()
  @IsUUID()
  issueId?: string;
}
