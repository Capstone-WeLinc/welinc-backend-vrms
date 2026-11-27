import { toGrant } from './auth-client';

// covers: spec 0007 AC-8 (user.systems passed through; missing counts as empty)
describe('toGrant', () => {
  const body = (user: Record<string, unknown>) => ({
    access_token: 'a',
    refresh_token: 'r',
    expires_in: 900,
    sid: 's',
    session_expires_at: '2026-11-10T00:00:00.000Z',
    user: {
      id: 'u1',
      name: 'Pedro',
      email: 'p@welinc.com',
      roles: [],
      ...user,
    },
  });

  it('passes user.systems through unchanged', () => {
    expect(toGrant(body({ systems: ['VMMS', 'VRMS'] }))?.user.systems).toEqual([
      'VMMS',
      'VRMS',
    ]);
  });

  it('treats a missing or malformed systems as an empty list', () => {
    expect(toGrant(body({}))?.user.systems).toEqual([]);
    expect(toGrant(body({ systems: 'VRMS' }))?.user.systems).toEqual([]);
  });

  // covers: VRMS spec 0027 step 6a (systemRoles and suiteAdmin passed through, display only)
  it('passes user.systemRoles and user.suiteAdmin through', () => {
    const grant = toGrant(
      body({
        systems: ['VMMS', 'VRMS'],
        systemRoles: [
          { system: 'VMMS', roles: ['ADMIN'] },
          { system: 'VRMS', roles: [] },
        ],
        suiteAdmin: true,
      }),
    );
    expect(grant?.user.systemRoles).toEqual([
      { system: 'VMMS', roles: ['ADMIN'] },
      { system: 'VRMS', roles: [] },
    ]);
    expect(grant?.user.suiteAdmin).toBe(true);
  });

  it('treats missing systemRoles and suiteAdmin as [] and false (an older welinc-auth)', () => {
    const grant = toGrant(body({ systems: ['VRMS'] }));
    expect(grant?.user.systemRoles).toEqual([]);
    expect(grant?.user.suiteAdmin).toBe(false);
  });

  it('drops malformed systemRoles entries and takes suiteAdmin only when it is true', () => {
    expect(toGrant(body({ systemRoles: 'VMMS' }))?.user.systemRoles).toEqual(
      [],
    );
    expect(
      toGrant(
        body({
          systemRoles: [
            null,
            'VMMS',
            { system: 3, roles: ['ADMIN'] },
            { system: 'BMS', roles: 'ADMIN' },
            { system: 'VMMS', roles: ['ADMIN', 7] },
            { system: 'VRMS', roles: ['MECHANIC'] },
          ],
        }),
      )?.user.systemRoles,
    ).toEqual([{ system: 'VRMS', roles: ['MECHANIC'] }]);
    for (const suiteAdmin of ['true', 1, null, false]) {
      expect(toGrant(body({ suiteAdmin }))?.user.suiteAdmin).toBe(false);
    }
  });
});
