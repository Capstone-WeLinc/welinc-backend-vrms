import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsNotEmpty,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Spec 0029 (child 0002): deciding a VMMS referral.

/** One finding as an issue line, after the Admin picked its system. */
export class ReferralIssueDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Describe the issue.' })
  @MaxLength(600)
  description: string;

  @IsUUID('all', { message: 'Choose a system.' })
  categoryId: string;
}

/** POST /vrms/referrals/:id/add-to-ticket (AC-9). */
export class AddReferralToTicketDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReferralIssueDto)
  issues: ReferralIssueDto[];

  /** The open ticket as the dialog loaded it: a change since answers 409 `STALE`. */
  @IsISO8601()
  updatedAt: string;
}

/** POST /vrms/referrals/:id/reject (AC-10). */
export class RejectReferralDto {
  @Transform(trim)
  @IsString()
  @Length(5, 500, { message: 'Say why, in 5 to 500 characters.' })
  reason: string;
}
