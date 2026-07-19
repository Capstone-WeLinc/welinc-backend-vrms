import { IsString, Matches } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/, {
    message:
      'Password must be at least 12 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character.',
  })
  password!: string;
}
