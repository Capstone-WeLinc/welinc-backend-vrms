import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { PermittedRequest } from './permissions.guard';

/** The caller's CASL ability, built by PermissionsGuard for this request only. */
export const CurrentAbility = createParamDecorator(
  (_: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<PermittedRequest>().ability,
);
