import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// Spec 0013, AC-12: helpful and rating are not cross checked
export class DiagnosisFeedbackDto {
  @IsBoolean()
  helpful!: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}
