import { ForbiddenException } from '@nestjs/common';
import {
  MODULE_DISABLED_MESSAGE,
  ModuleDisabledException,
} from './module-disabled';

// Spec 0012, AC-11: the same refusal body for every role, from the guard or a service

describe('ModuleDisabledException', () => {
  it('is a 403 with the code, the module and the fixed message', () => {
    const error = new ModuleDisabledException('knowledge');

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toEqual({
      statusCode: 403,
      code: 'MODULE_DISABLED',
      module: 'knowledge',
      message: 'This module is turned off by your Admin.',
    });
  });

  it('names the module it was raised for', () => {
    expect(
      (new ModuleDisabledException('ai').getResponse() as { module: string })
        .module,
    ).toBe('ai');
    expect(MODULE_DISABLED_MESSAGE).toBe(
      'This module is turned off by your Admin.',
    );
  });
});
