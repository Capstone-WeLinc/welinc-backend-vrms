import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Spec 0016, AC-19: POST /vrms/lookups/:list
export class CreateLookupValueDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Enter a name.' })
  @MaxLength(100, { message: 'Keep the name to 100 characters.' })
  name: string;
}

// PATCH /vrms/lookups/:list/:id
export class UpdateLookupValueDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Enter a name.' })
  @MaxLength(100, { message: 'Keep the name to 100 characters.' })
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
