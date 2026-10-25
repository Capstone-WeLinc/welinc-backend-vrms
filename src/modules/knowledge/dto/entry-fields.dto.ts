import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidationOptions,
} from 'class-validator';
import { RepairPriority } from '@prisma/client';

// Spec 0007, AC-18: the same limits the editor form shows.

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Trims every row and drops the empty ones before the limits are checked. */
const cleanList = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? (value as unknown[])
        .map((v) => (typeof v === 'string' ? v.trim() : v))
        .filter((v) => v !== '')
    : value;

/** Empty text means "no value". */
const blankToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? null : t;
};

function IsQuarterStep(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isQuarterStep',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'number' && Number.isInteger(value * 4),
        defaultMessage: () => 'Estimated hours go in steps of 0.25.',
      },
    },
    options,
  );
}

export class EntryFieldsDto {
  @Transform(trim)
  @IsString()
  @Length(3, 100, { message: 'Name must be 3 to 100 characters.' })
  name: string;

  @IsUUID('all', { message: 'Choose a category.' })
  categoryId: string;

  @IsEnum(RepairPriority, { message: 'Choose a suggested priority.' })
  suggestedPriority: RepairPriority;

  @IsOptional()
  @IsNumber({}, { message: 'Estimated hours must be a number.' })
  @Min(0.25, { message: 'Estimated hours must be 0.25 to 200.' })
  @Max(200, { message: 'Estimated hours must be 0.25 to 200.' })
  @IsQuarterStep()
  estimatedHours?: number | null;

  @Transform(trim)
  @IsString()
  @Length(10, 1000, { message: 'Symptoms must be 10 to 1000 characters.' })
  symptoms: string;

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(1000, {
    message: 'The description template can be up to 1000 characters.',
  })
  descriptionTemplate?: string | null;

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500, { message: 'Safety notes can be up to 500 characters.' })
  safetyNotes?: string | null;

  @Transform(cleanList)
  @IsArray()
  @ArrayMinSize(1, { message: 'Add at least one fix step.' })
  @ArrayMaxSize(20, { message: 'An entry can have up to 20 fix steps.' })
  @IsString({ each: true })
  @Length(3, 300, {
    each: true,
    message: 'Each fix step must be 3 to 300 characters.',
  })
  steps: string[];

  @IsOptional()
  @Transform(cleanList)
  @IsArray()
  @ArrayMaxSize(20, { message: 'An entry can have up to 20 parts.' })
  @IsString({ each: true })
  @Length(2, 100, {
    each: true,
    message: 'Each part must be 2 to 100 characters.',
  })
  parts?: string[];
}

export class UpdateEntryDto extends EntryFieldsDto {
  // The updatedAt the editor loaded; a different one on the server is a 409 (AC-20).
  @IsISO8601()
  lastUpdatedAt: string;
}
