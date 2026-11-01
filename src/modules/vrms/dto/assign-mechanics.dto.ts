import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsISO8601,
  ValidateNested,
} from 'class-validator';
import { MechanicAssignmentDto } from './create-repair.dto';

// Spec 0016, AC-17: assign in house mechanics to an Open ticket.
export class AssignMechanicsDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Choose at least one mechanic.' })
  @ValidateNested({ each: true })
  @Type(() => MechanicAssignmentDto)
  mechanics: MechanicAssignmentDto[];

  // Required, so the assign runs the stale check
  @IsISO8601()
  lastUpdatedAt: string;
}
