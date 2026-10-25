import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const blankToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? null : t;
};

// Spec 0007, AC-22: name 2 to 50, description up to 200.
export class CreateCategoryDto {
  @Transform(trim)
  @IsString()
  @Length(2, 50, { message: 'Name must be 2 to 50 characters.' })
  name: string;

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(200, { message: 'Description can be up to 200 characters.' })
  description?: string | null;
}

export class UpdateCategoryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 50, { message: 'Name must be 2 to 50 characters.' })
  name?: string;

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(200, { message: 'Description can be up to 200 characters.' })
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // Move up or down: the neighbour's sortOrder. The neighbour takes this one's old place.
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsISO8601()
  lastUpdatedAt: string;
}
