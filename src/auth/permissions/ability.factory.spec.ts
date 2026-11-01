import { subject } from '@casl/ability';
import { accessibleBy } from '@casl/prisma';
import { permittedFieldsOf } from '@casl/ability/extra';
import type { RepairTicket } from '@prisma/client';
import { buildAbility, COST_FIELDS } from './ability.factory';
import type { PermissionKey } from './catalog';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function ticketFor(authUserId: string) {
  return subject('RepairTicket', {
    id: 't1',
    assignments: [{ mechanic: { authUserId } }],
  } as unknown as RepairTicket);
}

const keys = (...k: PermissionKey[]) => new Set<PermissionKey>(k);

describe('buildAbility', () => {
  it('turns ticket.view into a Prisma where on the nested assignment', () => {
    const ability = buildAbility(ME, keys('ticket.view'));

    expect(accessibleBy(ability, 'read').ofType('RepairTicket')).toEqual({
      OR: [{ assignments: { some: { mechanic: { is: { authUserId: ME } } } } }],
    });
  });

  it('matches the nested condition on a loaded ticket', () => {
    const ability = buildAbility(ME, keys('ticket.view', 'ticket.work'));

    expect(ability.can('read', ticketFor(ME))).toBe(true);
    expect(ability.can('read', ticketFor(OTHER))).toBe(false);
    expect(ability.can('work', ticketFor(ME))).toBe(true);
    expect(ability.can('work', ticketFor(OTHER))).toBe(false);
  });

  it('gives ticket.view_all every ticket, with no condition', () => {
    const ability = buildAbility(ME, keys('ticket.view', 'ticket.view_all'));

    expect(ability.can('read', ticketFor(OTHER))).toBe(true);
    expect(accessibleBy(ability, 'read').ofType('RepairTicket')).toEqual({});
  });

  // Spec 0017, AC-15: adding photos and proof follows the caller's ticket visibility
  describe('ticket.files.add', () => {
    it('lets a Mechanic add only on their assigned tickets', () => {
      const ability = buildAbility(
        ME,
        keys('ticket.view', 'ticket.work', 'ticket.files.add'),
      );

      expect(ability.can('addFiles', ticketFor(ME))).toBe(true);
      expect(ability.can('addFiles', ticketFor(OTHER))).toBe(false);
      expect(accessibleBy(ability, 'addFiles').ofType('RepairTicket')).toEqual({
        OR: [
          { assignments: { some: { mechanic: { is: { authUserId: ME } } } } },
        ],
      });
    });

    it('lets anyone who sees every ticket add on every ticket, a Mechanic granted ticket.view_all too', () => {
      const ability = buildAbility(
        ME,
        keys('ticket.view', 'ticket.view_all', 'ticket.files.add'),
      );

      expect(ability.can('addFiles', ticketFor(OTHER))).toBe(true);
      expect(accessibleBy(ability, 'addFiles').ofType('RepairTicket')).toEqual(
        {},
      );
    });

    it('gives no add right without the key', () => {
      const ability = buildAbility(ME, keys('ticket.view', 'ticket.view_all'));

      expect(ability.can('addFiles', ticketFor(ME))).toBe(false);
    });
  });

  // Spec 0017, AC-15: documents and remove any carry no condition; the 404 check bounds them
  describe('ticket.documents.add and ticket.files.remove_any', () => {
    it('give addDocuments and removeAny on any ticket, for a Mechanic with ticket.view only too', () => {
      const ability = buildAbility(
        ME,
        keys('ticket.view', 'ticket.documents.add', 'ticket.files.remove_any'),
      );

      expect(ability.can('addDocuments', ticketFor(OTHER))).toBe(true);
      expect(ability.can('removeAny', ticketFor(OTHER))).toBe(true);
      expect(
        accessibleBy(ability, 'addDocuments').ofType('RepairTicket'),
      ).toEqual({});
    });

    it('give neither without the keys, and ticket.files.add alone gives neither', () => {
      const ability = buildAbility(
        ME,
        keys('ticket.view', 'ticket.view_all', 'ticket.files.add'),
      );

      expect(ability.can('addDocuments', 'RepairTicket')).toBe(false);
      expect(ability.can('removeAny', 'RepairTicket')).toBe(false);
    });
  });

  it('never shares ownership between two callers with the same keys', () => {
    const mine = buildAbility(ME, keys('ticket.view'));
    const theirs = buildAbility(OTHER, keys('ticket.view'));

    expect(mine.can('read', ticketFor(OTHER))).toBe(false);
    expect(theirs.can('read', ticketFor(ME))).toBe(false);
  });

  it('hides cost fields without ticket.costs.view', () => {
    const fieldsOf = (ability: ReturnType<typeof buildAbility>) =>
      permittedFieldsOf(ability, 'read', ticketFor(ME), {
        fieldsFrom: (rule) => rule.fields ?? [...COST_FIELDS, 'id'],
      });

    const chief = buildAbility(ME, keys('ticket.view', 'ticket.view_all'));
    const admin = buildAbility(
      ME,
      keys('ticket.view', 'ticket.view_all', 'ticket.costs.view'),
    );

    expect(fieldsOf(chief)).toEqual(['id']);
    expect(fieldsOf(admin)).toEqual([...COST_FIELDS, 'id']);
  });

  it('adds one Permission flag per key and nothing for keys not held', () => {
    const ability = buildAbility(ME, keys('audit.view'));

    expect(ability.can('audit.view', 'Permission')).toBe(true);
    expect(ability.can('users.manage', 'Permission')).toBe(false);
    expect(ability.can('read', 'RepairTicket')).toBe(false);
  });
});
