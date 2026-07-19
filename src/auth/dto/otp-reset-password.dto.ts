import { IsString, IsEmail, Matches } from 'class-validator';

/**
 * DTO for the public OTP-based password reset flow (POST /auth/reset-password).
 * Different from ResetPasswordDto which is the admin-only route.
 */
export class OtpResetPasswordDto {
  @IsEmail()
  email!: string;

  @IsString()
  otp!: string;

  @IsString()
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/, {
    message:
      'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character.',
  })
  newPassword!: string;
}
