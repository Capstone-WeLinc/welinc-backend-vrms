import { IsIn } from 'class-validator';
import { EntryFieldsDto } from './entry-fields.dto';

export class CreateEntryDto extends EntryFieldsDto {
  // "Save as draft" or "Publish" (AC-19)
  @IsIn(['DRAFT', 'ACTIVE'])
  status: 'DRAFT' | 'ACTIVE';
}
