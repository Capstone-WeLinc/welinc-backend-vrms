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
});
