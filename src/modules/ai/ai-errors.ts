import {
  ConflictException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';

// Spec 0013, API surface: the error bodies the panel reads by `code`

export const AI_UNAVAILABLE_MESSAGE =
  'AI is unavailable right now. Try again in a moment.';

export class AiUnavailableException extends ServiceUnavailableException {
  constructor() {
    super({
      statusCode: 503,
      code: 'AI_UNAVAILABLE',
      message: AI_UNAVAILABLE_MESSAGE,
    });
  }
}

export class TicketClosedException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'TICKET_CLOSED',
      message: 'This ticket is closed, so a new diagnosis can’t run.',
    });
  }
}

export class AiBusyException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'AI_BUSY',
      message: 'A diagnosis is already running on this ticket.',
    });
  }
}

export class AiRateLimitedException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      {
        statusCode: 429,
        code: 'AI_RATE_LIMITED',
        retryAfterSeconds,
        message: 'You’ve reached the hourly limit for AI diagnoses.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
