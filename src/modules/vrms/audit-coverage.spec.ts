import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORY,
  type AuditAction,
  auditData,
  toAuditEvent,
} from './audit-events';

// Spec 0021, AC-6: every ticket action that exists today writes its audit row. This is the list
// of every ticket changing service method, the actions it writes, and the test that drives the
// method and asserts that action. Adding a method or a written type means adding a line here;
// a type nobody writes (other than the reserved ones) fails the build.

const MODULES = join(__dirname, '..');

type Entry = {
  method: string;
  file: string;
  writes: AuditAction[];
  /** The spec file that calls the method and asserts the action. */
  provedBy: string;
};

const COVERAGE: Entry[] = [
  {
    method: 'create',
    file: 'vrms/repairs.service.ts',
    writes: ['CREATED', 'MECHANIC_ASSIGNED'],
    provedBy: 'vrms/repairs.knowledge.spec.ts',
  },
  {
    method: 'updateStatus',
    file: 'vrms/repairs.service.ts',
    writes: ['STATUS_CHANGE'],
    provedBy: 'vrms/repairs.status.spec.ts',
  },
  {
    // The relocking save through the status endpoint
    method: 'saveUnlocked',
    file: 'vrms/repairs.service.ts',
    writes: ['COST_UPDATE', 'TICKET_EDITED', 'LOCKED'],
    provedBy: 'vrms/repairs.status.spec.ts',
  },
  {
    method: 'updateCosts',
    file: 'vrms/repairs.service.ts',
    writes: ['COST_UPDATE', 'LOCKED'],
    provedBy: 'vrms/repairs.status.spec.ts',
  },
  {
    method: 'unlockTicket',
    file: 'vrms/repairs.service.ts',
    writes: ['UNLOCK'],
    provedBy: 'vrms/repairs.status.spec.ts',
  },
  {
    method: 'linkKnowledge',
    file: 'vrms/repairs.service.ts',
    writes: ['KNOWLEDGE_LINK'],
    provedBy: 'vrms/repairs.knowledge.spec.ts',
  },
  {
    method: 'checkStep',
    file: 'vrms/repairs.service.ts',
    writes: ['STEP_CHECKED', 'STEP_UNCHECKED'],
    provedBy: 'vrms/repairs.steps.spec.ts',
  },
  {
    method: 'editDetails',
    file: 'vrms/ticket-edits.service.ts',
    writes: ['TICKET_EDITED'],
    provedBy: 'vrms/ticket-edits.spec.ts',
  },
  {
    method: 'setMechanics',
    file: 'vrms/ticket-edits.service.ts',
    writes: ['MECHANIC_ASSIGNED', 'MECHANIC_UNASSIGNED'],
    provedBy: 'vrms/ticket-edits.spec.ts',
  },
  {
    method: 'addIssue',
    file: 'vrms/ticket-edits.service.ts',
    writes: ['ISSUE_ADDED'],
    provedBy: 'vrms/ticket-edits.spec.ts',
  },
  {
    method: 'editIssue',
    file: 'vrms/ticket-edits.service.ts',
    writes: ['ISSUE_EDITED'],
    provedBy: 'vrms/ticket-edits.spec.ts',
  },
  {
    method: 'removeIssue',
    file: 'vrms/ticket-edits.service.ts',
    writes: ['ISSUE_REMOVED'],
    provedBy: 'vrms/ticket-edits.spec.ts',
  },
  {
    // The unassign when a mechanic is deactivated or loses their VRMS role
    method: 'release',
    file: 'vrms/mechanic-work.service.ts',
    writes: ['MECHANIC_UNASSIGNED'],
    provedBy: 'vrms/mechanic-work.service.spec.ts',
  },
  {
    method: 'upload',
    file: 'attachments/attachments.service.ts',
    writes: ['ATTACHMENT_ADDED'],
    provedBy: 'attachments/attachments.service.spec.ts',
  },
  {
    method: 'remove',
    file: 'attachments/attachments.service.ts',
    writes: ['ATTACHMENT_REMOVED'],
    provedBy: 'attachments/attachments.service.spec.ts',
  },
  {
    method: 'move',
    file: 'attachments/attachments.service.ts',
    writes: ['ATTACHMENT_MOVED'],
    provedBy: 'attachments/attachments.service.spec.ts',
  },
];

/** Types nothing writes today: reserved for features 33 and 30, and spec 0003's backfill. */
const NOT_WRITTEN: AuditAction[] = [
  'STATUS_OVERRIDE',
  'TRANSFER_REQUESTED',
  'TRANSFER_APPROVED',
  'TRANSFER_DECLINED',
  'TRANSFER_CANCELLED',
  'GARAGE_CHANGE',
];

const read = (file: string) => readFileSync(join(MODULES, file), 'utf8');

describe('audit coverage (spec 0021, AC-6)', () => {
  it('every event type is written by a listed method, or is one nothing writes yet', () => {
    const written = new Set(COVERAGE.flatMap((e) => e.writes));
    const missing = AUDIT_ACTIONS.filter(
      (a) => !written.has(a) && !NOT_WRITTEN.includes(a),
    );
    expect(missing).toEqual([]);
    // And a reserved type someone starts writing must leave NOT_WRITTEN
    expect(NOT_WRITTEN.filter((a) => written.has(a))).toEqual([]);
  });

  it.each(COVERAGE.map((e) => [`${e.file} ${e.method}`, e]))(
    '%s exists and its test asserts every action it writes',
    (_name, entry) => {
      const { method, file, writes, provedBy } = entry;
      expect(read(file)).toMatch(
        new RegExp(`\\n  (private )?(async )?${method}\\(`),
      );
      const proof = read(provedBy);
      for (const action of writes) {
        expect({ action, found: proof.includes(`'${action}'`) }).toEqual({
          action,
          found: true,
        });
      }
    },
  );

  it('every row carries ticket id, type, actor, time, changes and note, or SYSTEM with no actor', () => {
    const now = new Date('2026-11-04T00:00:00.000Z');
    const actor = {
      sub: '00000000-0000-4000-8000-000000000002',
      email: 'vrms.admin@welinc.com',
      name: 'Victor Ramos',
      roles: [{ role: 'ADMIN', system: 'VRMS' }],
      system: 'VRMS',
    };
    const data = auditData(
      actor,
      { action: 'LOCKED', changes: [], note: null },
      now,
    );
    expect(data).toEqual({
      actorUserId: actor.sub,
      actorName: 'Victor Ramos',
      actorEmail: actor.email,
      actorRole: 'ADMIN',
      action: 'LOCKED',
      changes: [],
      note: null,
      createdAt: now,
    });

    const row = {
      id: '00000000-0000-4000-8000-0000000000ee',
      action: 'MECHANIC_UNASSIGNED',
      actorUserId: null,
      actorName: null,
      actorEmail: null,
      actorRole: 'SYSTEM',
      changes: [],
      note: 'Account deactivated',
      createdAt: now,
      repairTicket: { id: 't1', repairNumber: 'REP-1' },
    };
    expect(toAuditEvent(row)).toMatchObject({
      actor: null,
      category: AUDIT_CATEGORY.MECHANIC_UNASSIGNED,
      ticket: { id: 't1' },
    });
    // AC-8: a stored action outside the catalog reads as category null
    expect(toAuditEvent({ ...row, action: 'OLD_THING' }).category).toBeNull();
  });
});
