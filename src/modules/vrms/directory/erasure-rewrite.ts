import { Prisma } from '@prisma/client';

// Suite spec 0012, AC-25: when welinc-auth erases a person, VRMS rewrites every name and email
// copy it keeps for that user id to "Deleted user" and null. Free text people typed (notes,
// comments) is left as written.

export const ERASED_NAME = 'Deleted user';

/**
 * Every column pair that copies a person's name or email beside their welinc-auth id, matched by
 * that id. A new copy column must join this list, or it leaks after an erasure:
 * `erasure-rewrite.spec.ts` reads `prisma/schema.prisma` and fails when one is missing.
 */
export const ERASURE_COPY_COLUMNS: readonly {
  table: string;
  idColumn: string;
  nameColumn?: string;
  emailColumn?: string;
}[] = [
  {
    table: 'mechanics',
    idColumn: 'auth_user_id',
    nameColumn: 'name',
    emailColumn: 'email',
  },
  {
    table: 'repair_tickets',
    idColumn: 'reported_by_user_id',
    nameColumn: 'reported_by_name',
  },
  {
    table: 'repair_tickets',
    idColumn: 'verified_by_user_id',
    nameColumn: 'verified_by_name',
  },
  {
    table: 'repair_tickets',
    idColumn: 'edited_by_user_id',
    nameColumn: 'edited_by_name',
  },
  {
    table: 'ticket_assignments',
    idColumn: 'assigned_by_user_id',
    nameColumn: 'assigned_by_name',
  },
  {
    table: 'attachments',
    idColumn: 'uploaded_by_user_id',
    nameColumn: 'uploaded_by_name',
  },
  {
    table: 'attachments',
    idColumn: 'deleted_by_user_id',
    nameColumn: 'deleted_by_name',
  },
  {
    // Spec 0029: the VRMS Admin who opened, added or rejected a VMMS referral
    table: 'referrals',
    idColumn: 'decided_by_user_id',
    nameColumn: 'decided_by_name',
  },
  {
    // Spec 0029 (child 0003): the VRMS Admin who answered a BMS expedite request
    table: 'expedite_requests',
    idColumn: 'decided_by_user_id',
    nameColumn: 'decided_by_name',
  },
  {
    table: 'audit_logs',
    idColumn: 'actor_user_id',
    nameColumn: 'actor_name',
    emailColumn: 'actor_email',
  },
  {
    table: 'knowledge_entry_changes',
    idColumn: 'actor_user_id',
    nameColumn: 'actor_name',
    emailColumn: 'actor_email',
  },
  // permission_changes moved to welinc-auth (suite spec 0013, AC-30), whose erasure blanks it
  {
    table: 'setting_changes',
    idColumn: 'actor_user_id',
    nameColumn: 'actor_name',
    emailColumn: 'actor_email',
  },
  {
    table: 'lookup_value_changes',
    idColumn: 'actor_user_id',
    nameColumn: 'actor_name',
    emailColumn: 'actor_email',
  },
  {
    table: 'vehicle_changes',
    idColumn: 'actor_user_id',
    nameColumn: 'actor_name',
    emailColumn: 'actor_email',
  },
];

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/**
 * Replaces, anywhere in an audit `changes` value, a string equal to the old name with
 * "Deleted user" and one equal to the old email (any case) with null. Answers the same object
 * when nothing matched.
 */
export function scrubChanges(
  value: unknown,
  oldName: string | null,
  oldEmail: string | null,
): unknown {
  if (typeof value === 'string') {
    if (oldName && value === oldName) return ERASED_NAME;
    if (oldEmail && value.toLowerCase() === oldEmail.toLowerCase()) return null;
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const out = scrubChanges(item, oldName, oldEmail);
      if (out !== item) changed = true;
      return out;
    });
    return changed ? next : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const out = scrubChanges(item, oldName, oldEmail);
      if (out !== item) changed = true;
      next[key] = out;
    }
    return changed ? next : value;
  }
  return value;
}

/**
 * AC-25: inside the feed change's transaction. Turns on `vrms.erasure` for this transaction only
 * (the one way past the audit_logs trigger), reads the old name and email (the mechanics row,
 * else the newest audit row the person made), then rewrites every copy. Works with no mechanics
 * row too (a former mechanic now only in another system). Running it twice changes nothing more.
 */
export async function rewriteErased(
  tx: Prisma.TransactionClient,
  authUserId: string,
): Promise<{ rows: number }> {
  await tx.$queryRaw`SELECT set_config('vrms.erasure', 'on', true)`;

  const mechanic = await tx.mechanic.findUnique({
    where: { authUserId },
    select: { name: true, email: true },
  });
  const lastAudit = mechanic
    ? null
    : await tx.auditLog.findFirst({
        where: { actorUserId: authUserId, actorName: { not: ERASED_NAME } },
        orderBy: { createdAt: 'desc' },
        select: { actorName: true, actorEmail: true },
      });
  const oldName = mechanic?.name ?? lastAudit?.actorName ?? null;
  const oldEmail = mechanic?.email ?? lastAudit?.actorEmail ?? null;

  // Audit `changes` first, while the old values are known: only rows that mention them
  let rows = 0;
  const needles = [oldName, oldEmail].filter(
    (v): v is string => !!v && v !== ERASED_NAME,
  );
  if (needles.length > 0) {
    const candidates = await tx.$queryRaw<{ id: string; changes: unknown }[]>`
      SELECT "id", "changes" FROM "audit_logs"
       WHERE ${Prisma.join(
         needles.map(
           (n) =>
             Prisma.sql`"changes"::text ILIKE ${'%' + n.replace(/[\\%_]/g, (c) => '\\' + c) + '%'}`,
         ),
         ' OR ',
       )}`;
    for (const row of candidates) {
      const next = scrubChanges(row.changes, oldName, oldEmail);
      if (next === row.changes) continue;
      rows += await tx.$executeRaw`
        UPDATE "audit_logs" SET "changes" = ${JSON.stringify(next)}::jsonb WHERE "id" = ${row.id}::uuid`;
    }
  }

  for (const copy of ERASURE_COPY_COLUMNS) {
    const sets: string[] = [];
    if (copy.nameColumn) sets.push(`${q(copy.nameColumn)} = '${ERASED_NAME}'`);
    if (copy.emailColumn) sets.push(`${q(copy.emailColumn)} = NULL`);
    const differs: string[] = [];
    if (copy.nameColumn)
      differs.push(`${q(copy.nameColumn)} IS DISTINCT FROM '${ERASED_NAME}'`);
    if (copy.emailColumn) differs.push(`${q(copy.emailColumn)} IS NOT NULL`);
    // Identifiers come only from the constant above; the id is a bound parameter
    rows += await tx.$executeRawUnsafe(
      `UPDATE ${q(copy.table)} SET ${sets.join(', ')}
        WHERE ${q(copy.idColumn)} = $1::uuid AND (${differs.join(' OR ')})`,
      authUserId,
    );
  }
  return { rows };
}
