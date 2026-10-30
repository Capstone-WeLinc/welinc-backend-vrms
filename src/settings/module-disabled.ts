import { ForbiddenException } from '@nestjs/common';
import type { ModuleName } from './catalog';

export const MODULE_DISABLED_MESSAGE =
  'This module is turned off by your Admin.';

/** Spec 0012, AC-11: the same body for every role, from the guard or a service. */
export class ModuleDisabledException extends ForbiddenException {
  constructor(module: ModuleName) {
    super({
      statusCode: 403,
      code: 'MODULE_DISABLED',
      module,
      message: MODULE_DISABLED_MESSAGE,
    });
  }
}
