import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { EntryFieldsDto } from './entry-fields.dto';

export class CreateEntryDto extends EntryFieldsDto {
  // "Save as draft" or "Publish" (AC-19)
  @IsIn(['DRAFT', 'ACTIVE'])
  status: 'DRAFT' | 'ACTIVE';

  // Create from a suggestion group: the still ticked issues to link (AC-33)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  linkIssueIds?: string[];

  // Create from a mechanic's "Suggest an entry": marked done with the create (AC-35)
  @IsOptional()
  @IsUUID()
  suggestionId?: string;
}
