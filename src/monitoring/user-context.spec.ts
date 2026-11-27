import * as Sentry from '@sentry/nestjs';
import type { AuthUser } from '../auth/account-check';
import { SystemType } from '../auth/roles';
import { UserRole } from '../auth/built-in-roles.testing';
import { setSentryUser } from './user-context';

// covers: VRMS spec 0025 AC-1, AC-6

jest.mock('@sentry/nestjs', () => ({ setUser: jest.fn(), setTag: jest.fn() }));

const caller = (roles: AuthUser['roles']): AuthUser => ({
  sub: '00000000-0000-4000-8000-000000000002',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  system: SystemType.VRMS,
  roles,
});

describe('setSentryUser', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sets the user id and nothing else about the person', () => {
    setSentryUser(caller([{ role: UserRole.ADMIN, system: SystemType.VRMS }]));

    expect(Sentry.setUser).toHaveBeenCalledTimes(1);
    expect(Sentry.setUser).toHaveBeenCalledWith({
      id: '00000000-0000-4000-8000-000000000002',
    });
  });

  it('never sends the email or the name to Sentry', () => {
    setSentryUser(caller([{ role: UserRole.ADMIN, system: SystemType.VRMS }]));

    const sent = JSON.stringify([
      (Sentry.setUser as jest.Mock).mock.calls,
      (Sentry.setTag as jest.Mock).mock.calls,
    ]);
    expect(sent).not.toContain('vrms.admin@welinc.com');
    expect(sent).not.toContain('Victor Ramos');
  });

  it('tags the role names the caller holds in VRMS, joined by a comma', () => {
    setSentryUser(
      caller([
        { role: UserRole.CHIEF_MECHANIC, system: SystemType.VRMS },
        { role: UserRole.MECHANIC, system: SystemType.VRMS },
      ]),
    );

    expect(Sentry.setTag).toHaveBeenCalledWith(
      'role',
      'CHIEF_MECHANIC,MECHANIC',
    );
  });

  it('leaves out roles the caller holds in other systems', () => {
    setSentryUser(
      caller([
        { role: UserRole.ADMIN, system: SystemType.VRMS },
        { role: UserRole.OPERATIONS, system: SystemType.VMMS },
        { role: UserRole.CUSTOMER_SUPPORT, system: SystemType.BMS },
      ]),
    );

    expect(Sentry.setTag).toHaveBeenCalledWith('role', 'ADMIN');
  });

  it('clears the role tag when the caller has no VRMS role', () => {
    setSentryUser(
      caller([{ role: UserRole.OPERATIONS, system: SystemType.VMMS }]),
    );

    expect(Sentry.setTag).toHaveBeenCalledWith('role', undefined);
  });

  it('clears the role tag when the caller has no roles at all', () => {
    setSentryUser(caller([]));

    expect(Sentry.setTag).toHaveBeenCalledWith('role', undefined);
  });
});
