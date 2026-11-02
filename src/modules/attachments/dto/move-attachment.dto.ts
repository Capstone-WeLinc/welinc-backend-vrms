import { IsString } from 'class-validator';

// Spec 0018, AC-9: the group a photo moves to. Only a string here, so a 404 (the photo is not
// visible) answers before a 400 (not a photo kind); the service checks the value.
export class MoveAttachmentDto {
  @IsString()
  kind: string;
}
