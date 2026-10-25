import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { SuggestionKind } from '@prisma/client';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Spec 0007, AC-35: a reader's "Suggest a change" or "Suggest an entry".
export class CreateSuggestionDto {
  @IsEnum(SuggestionKind)
  kind: SuggestionKind;

  // Required for CHANGE; the service checks it
  @IsOptional()
  @IsUUID()
  entryId?: string;

  // The ticket issue it came from, when suggested from a ticket
  @IsOptional()
  @IsUUID()
  repairIssueId?: string;

  @Transform(trim)
  @IsString()
  @Length(5, 1000, { message: 'A suggestion must be 5 to 1000 characters.' })
  body: string;
}

export class ResolveSuggestionDto {
  @IsIn(['ACCEPTED', 'DISMISSED'])
  status: 'ACCEPTED' | 'DISMISSED';
}

// AC-34: dismiss a whole group of similar issues so they never group again.
export class DismissGroupDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  issueIds: string[];
}
