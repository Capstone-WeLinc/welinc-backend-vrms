import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class UnlockTicketDto {
  @IsString()
  @IsNotEmpty({ message: 'An unlock reason is required' })
  @MaxLength(500)
  unlockReason: string;
}
