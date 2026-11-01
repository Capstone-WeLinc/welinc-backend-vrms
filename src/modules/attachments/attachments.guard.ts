import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { PermittedRequest } from '../../auth/permissions/permissions.guard';
import { attachmentError } from './attachment-errors';
import { AttachmentsService } from './attachments.service';

/**
 * Spec 0017, AC-12a: the upload body is not read until the caller is known to see the ticket.
 * Runs after the global JWT and permission guards, before the file interceptor.
 */
@Injectable()
export class UploadAccessGuard implements CanActivate {
  constructor(private readonly attachments: AttachmentsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<PermittedRequest & { params: { id?: string } }>();
    this.attachments.requireStore();
    // 404 for a ticket the caller can't see, and for an id that isn't a uuid
    await this.attachments.findVisibleTicket(
      request.ability,
      request.params.id ?? '',
    );
    return true;
  }
}

/** Spec 0017, AC-12: 30 uploads a minute per signed in user, counted in this replica. */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const user = (req as Partial<PermittedRequest>).user;
    return Promise.resolve(user?.sub ?? String(req.ip));
  }

  protected throwThrottlingException(): Promise<void> {
    throw attachmentError(
      HttpStatus.TOO_MANY_REQUESTS,
      'UPLOAD_RATE_LIMITED',
      'Too many uploads in a minute. Wait a moment and try again.',
    );
  }
}
