import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Spec 0020, AC-9: 20 per page unless asked, never more than 50. */
export const VEHICLE_CHANGES_PAGE = 20;

// GET /vrms/vehicles/:id/changes
export class VehicleChangesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  // Opaque position from the previous page's nextCursor
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
