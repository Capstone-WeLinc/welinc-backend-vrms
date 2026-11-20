import { PERMISSION_KEY } from '../auth/permissions/permission.decorators';
import { SentryTestController } from './sentry-test.controller';

// covers: VRMS spec 0025 AC-16

describe('SentryTestController', () => {
  it('throws the test error so an issue can arrive in Sentry', () => {
    expect(() => new SentryTestController().sentryTest()).toThrow(
      'Sentry test error from backend-vrms (spec 0025)',
    );
  });

  it('needs the settings.manage permission', () => {
    const keys: unknown = Reflect.getMetadata(
      PERMISSION_KEY,
      SentryTestController.prototype.sentryTest,
    );

    expect(keys).toEqual(['settings.manage']);
  });

  it('answers on POST /vrms/debug/sentry-test', () => {
    const path: unknown = Reflect.getMetadata('path', SentryTestController);
    const route: unknown = Reflect.getMetadata(
      'path',
      SentryTestController.prototype.sentryTest,
    );

    expect(path).toBe('vrms/debug');
    expect(route).toBe('sentry-test');
  });
});
