/* eslint-disable @typescript-eslint/unbound-method -- jest mocks are asserted on, never called detached */
import {
  ExecutionContext,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { buildAbility } from '../../auth/permissions/ability.factory';
import { UploadAccessGuard, UserThrottlerGuard } from './attachments.guard';
import type { AttachmentsService } from './attachments.service';

// Spec 0017, AC-12 and AC-12a: no body is read for a ticket the caller can't see, and uploads are
// rate limited per signed in user.

function contextFor(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('UploadAccessGuard (AC-12a)', () => {
  const ability = buildAbility('me', new Set(['ticket.view_all']));

  function service(over: Partial<AttachmentsService> = {}) {
    return {
      requireStore: jest.fn(),
      findVisibleTicket: jest.fn().mockResolvedValue({ id: 't' }),
      ...over,
    } as unknown as AttachmentsService;
  }

  it('lets the request through when the caller sees the ticket', async () => {
    const attachments = service();
    const guard = new UploadAccessGuard(attachments);
    await expect(
      guard.canActivate(contextFor({ ability, params: { id: 'abc' } })),
    ).resolves.toBe(true);
    expect(attachments.findVisibleTicket).toHaveBeenCalledWith(ability, 'abc');
  });

  it('answers 404 when the ticket is not visible', async () => {
    const guard = new UploadAccessGuard(
      service({
        findVisibleTicket: jest
          .fn()
          .mockRejectedValue(new NotFoundException('Repair ticket not found')),
      }),
    );
    await expect(
      guard.canActivate(contextFor({ ability, params: { id: 'abc' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('checks storage first, so an unconfigured store answers before any lookup', async () => {
    const attachments = service({
      requireStore: jest.fn(() => {
        throw new HttpException('storage', 503);
      }),
    });
    const guard = new UploadAccessGuard(attachments);
    await expect(
      guard.canActivate(contextFor({ ability, params: { id: 'abc' } })),
    ).rejects.toMatchObject({ status: 503 });
    expect(attachments.findVisibleTicket).not.toHaveBeenCalled();
  });

  it('looks up an empty id when the route has none, never skipping the check', async () => {
    const attachments = service();
    await new UploadAccessGuard(attachments).canActivate(
      contextFor({ ability, params: {} }),
    );
    expect(attachments.findVisibleTicket).toHaveBeenCalledWith(ability, '');
  });
});

describe('UserThrottlerGuard (AC-12)', () => {
  // The base class needs Nest's throttler wiring; these two methods don't, so skip the constructor
  const guard = Object.create(UserThrottlerGuard.prototype) as {
    getTracker(req: object): Promise<string>;
    throwThrottlingException(): Promise<void>;
  };

  it('counts by signed in user id, not by address', async () => {
    await expect(
      guard.getTracker({ user: { sub: 'user-1' }, ip: '10.0.0.1' }),
    ).resolves.toBe('user-1');
  });

  it('falls back to the address when there is no user', async () => {
    await expect(guard.getTracker({ ip: '10.0.0.1' })).resolves.toBe(
      '10.0.0.1',
    );
  });

  it('answers 429 UPLOAD_RATE_LIMITED with the message the web shows', () => {
    let caught: unknown;
    try {
      void guard.throwThrottlingException();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    const error = caught as HttpException;
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({
      code: 'UPLOAD_RATE_LIMITED',
      message: 'Too many uploads in a minute. Wait a moment and try again.',
    });
  });
});
