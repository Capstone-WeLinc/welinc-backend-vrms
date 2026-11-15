import 'reflect-metadata';
import { PERMISSION_KEY } from '../../../auth/permissions/permission.decorators';
import { VehiclesController } from './vehicles.controller';

// Spec 0020, AC-14: every vehicle endpoint needs vehicle.manage, and nothing else opens it.
// The guard reads this metadata (spec 0011, AC-7); a route with none is denied.

const proto = VehiclesController.prototype as unknown as Record<
  string,
  (...args: never[]) => unknown
>;

function keysOf(method: string) {
  return Reflect.getMetadata(PERMISSION_KEY, proto[method]) as
    string[] | undefined;
}

describe('VehiclesController permissions (AC-14)', () => {
  it.each(['list', 'changes', 'update', 'setStatus'])(
    '%s needs exactly vehicle.manage',
    (method) => {
      expect(keysOf(method)).toEqual(['vehicle.manage']);
    },
  );

  it('leaves no route without a key', () => {
    const methods = Object.getOwnPropertyNames(proto).filter(
      (name) => name !== 'constructor' && typeof proto[name] === 'function',
    );
    expect(methods.length).toBeGreaterThanOrEqual(4);
    for (const method of methods) {
      expect(keysOf(method)).toBeDefined();
    }
  });
});
