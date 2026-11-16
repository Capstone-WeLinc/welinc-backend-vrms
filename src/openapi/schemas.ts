import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Contract 0001 section 11: every error a WeLinc service sends itself. */
export class CodedError {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({
    description:
      'A sentence for people; may change. Match on `code`, never on this.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  })
  message!: string | string[];

  @ApiProperty({ example: 'Bad Request' })
  error!: string;

  @ApiPropertyOptional({
    description:
      'The stable error code (contract 0001 section 11). Absent on a plain validation 400.',
    example: 'VALIDATION_FAILED',
  })
  code?: string;
}

/** Contract 0001 section 11: `POST /auth/token` answers errors in the OAuth shape (RFC 6749). */
export class OAuthError {
  @ApiProperty({ example: 'invalid_grant' })
  error!: string;

  @ApiPropertyOptional({ example: 'The code is invalid or used' })
  error_description?: string;
}
