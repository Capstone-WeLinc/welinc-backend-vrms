import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// Spec 0011, AC-18. Unknown roles or keys and locked cells are refused by the service (400).

export class PermissionCellChangeDto {
  @IsString()
  @MaxLength(30)
  role!: string;

  @IsString()
  @MaxLength(60)
  permission!: string;

  @IsBoolean()
  allowed!: boolean;
}

export class UpdatePermissionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PermissionCellChangeDto)
  changes!: PermissionCellChangeDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsInt()
  @Min(1)
  version!: number;
}

export class ListPermissionChangesQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
