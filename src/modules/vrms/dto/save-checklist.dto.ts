import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// Spec 0023, AC-6: one checklist step as sent; an id for a kept step, none for a new one.
export class ChecklistStepDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  // The 3 to 300 rule runs after normalizing (AC-5, AC-8); this only bounds the raw body
  @IsString()
  @MaxLength(2000)
  text: string;
}

// Spec 0023, AC-6: the issue's full checklist in order, with the lock it was opened at.
export class SaveChecklistDto {
  @IsInt()
  @Min(0)
  checklistVersion: number;

  @IsArray()
  // The web drops empty new rows before sending (AC-5)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ChecklistStepDto)
  steps: ChecklistStepDto[];
}
