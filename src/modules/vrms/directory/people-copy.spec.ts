import type { DirectoryUser } from './auth-directory.client';
import { applyPerson, sweepPeople, toTeamPerson } from './people-copy';

// covers: suite spec 0014 task 13a (the Users page copy: who gets a row, erasure, the sweep, the
// list shape)

const person = (fields: Partial<DirectoryUser> = {}): DirectoryUser => ({
  id: '00000000-0000-4000-8000-000000001201',
  name: 'Ramon Villanueva',
  email: 'Vrms.Chief@Welinc.com',
  phone: null,
  picture: '/uploads/profile/abc.webp',
  isActive: true,
  deleted: false,
  erased: false,
  roles: ['CHIEF_MECHANIC'],
  temporaryRoles: [],
  updatedAt: '2026-11-13T00:00:00.000Z',
  ...fields,
});

function fakeTx() {
  return {
    vrmsPerson: {
      upsert: jest.fn(() => Promise.resolve({})),
      deleteMany: jest.fn(() => Promise.resolve({ count: 2 })),
    },
  };
}

describe('applyPerson', () => {
  it('writes a VRMS person with a lowercased email and their picture', async () => {
    const tx = fakeTx();
    await applyPerson(tx as never, person());
    expect(tx.vrmsPerson.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { authUserId: person().id },
        update: expect.objectContaining({
          email: 'vrms.chief@welinc.com',
          picture: '/uploads/profile/abc.webp',
          roles: ['CHIEF_MECHANIC'],
          temporaryRoles: [],
          isActive: true,
          deleted: false,
        }) as unknown,
      }),
    );
    expect(tx.vrmsPerson.deleteMany).not.toHaveBeenCalled();
  });

  it('keeps a deleted person in the grace period, marked deleted', async () => {
    const tx = fakeTx();
    await applyPerson(tx as never, person({ deleted: true, isActive: false }));
    expect(tx.vrmsPerson.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          deleted: true,
          isActive: false,
        }) as unknown,
      }),
    );
  });

  it('keeps a temporary grant, and only the roles it covers as temporary', async () => {
    const tx = fakeTx();
    await applyPerson(
      tx as never,
      person({
        roles: ['MECHANIC', 'ADMIN'],
        temporaryRoles: ['ADMIN', 'VMMS_ONLY'],
      }),
    );
    expect(tx.vrmsPerson.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          temporaryRoles: ['ADMIN'],
        }) as unknown,
      }),
    );
  });

  it('reads a missing temporaryRoles (an older welinc-auth) as none', async () => {
    const tx = fakeTx();
    await applyPerson(tx as never, person({ temporaryRoles: undefined }));
    expect(tx.vrmsPerson.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ temporaryRoles: [] }) as unknown,
      }),
    );
  });

  it.each([
    ['erased', { erased: true }],
    ['without a VRMS role', { roles: [] }],
  ])('removes the row of a person %s', async (_label, fields) => {
    const tx = fakeTx();
    await applyPerson(tx as never, person(fields));
    expect(tx.vrmsPerson.deleteMany).toHaveBeenCalledWith({
      where: { authUserId: person().id },
    });
    expect(tx.vrmsPerson.upsert).not.toHaveBeenCalled();
  });
});

describe('sweepPeople', () => {
  it('removes everyone the full read did not see', async () => {
    const tx = fakeTx();
    await expect(sweepPeople(tx as never, new Set(['a', 'b']))).resolves.toBe(
      2,
    );
    expect(tx.vrmsPerson.deleteMany).toHaveBeenCalledWith({
      where: { authUserId: { notIn: ['a', 'b'] } },
    });
  });
});

describe('toTeamPerson', () => {
  it('answers the id and the { role, system } shape the Users page reads', () => {
    expect(
      toTeamPerson({
        authUserId: 'u1',
        name: 'Ana',
        email: 'ana@welinc.com',
        picture: null,
        roles: ['MECHANIC'],
        temporaryRoles: [],
        isActive: true,
        deleted: false,
      }),
    ).toEqual({
      id: 'u1',
      name: 'Ana',
      email: 'ana@welinc.com',
      picture: null,
      roles: [{ role: 'MECHANIC', system: 'VRMS' }],
      temporaryRoles: [],
      isActive: true,
      deleted: false,
    });
  });
});
