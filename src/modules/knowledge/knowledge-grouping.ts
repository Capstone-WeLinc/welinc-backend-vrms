import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { KNOWLEDGE_SETTINGS } from './knowledge.settings';

// Spec 0007, Grouping. Candidates are the newest unlinked, not dismissed issues on tickets that are
// not cancelled. One self join finds similar pairs inside a category; the pure function below joins
// the pairs into groups. The AI rework (feature 3) can swap the pair query for embeddings here.

export type Pair = { a: string; b: string };
export type Candidate = { id: string; createdAt: Date };

/**
 * Connected components of the pairs, keeping groups of at least minSize, biggest first, then the
 * one with the newest issue. Each group lists its issue ids newest first.
 */
export function groupPairs(
  candidates: Candidate[],
  pairs: Pair[],
  minSize: number = KNOWLEDGE_SETTINGS.GROUP_MIN_SIZE,
): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression keeps later finds short
    let node = x;
    while (parent.get(node) !== root) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  for (const c of candidates) parent.set(c.id, c.id);
  for (const { a, b } of pairs) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const created = new Map(candidates.map((c) => [c.id, c.createdAt.getTime()]));
  const groups = new Map<string, string[]>();
  for (const c of candidates) {
    const root = find(c.id);
    const members = groups.get(root) ?? [];
    members.push(c.id);
    groups.set(root, members);
  }
  const newest = (ids: string[]) =>
    Math.max(...ids.map((id) => created.get(id)!));
  return [...groups.values()]
    .filter((ids) => ids.length >= minSize)
    .map((ids) => ids.sort((x, y) => created.get(y)! - created.get(x)!))
    .sort((x, y) => y.length - x.length || newest(y) - newest(x));
}

/** The groups of similar unlinked issues, at most `limit`, each newest first (AC-32). */
export async function findIssueGroups(prisma: PrismaService, limit = 20) {
  const s = KNOWLEDGE_SETTINGS;
  const candidates = await prisma.$queryRaw<
    { id: string; created_at: Date }[]
  >(Prisma.sql`
    SELECT ri.id, ri.created_at
    FROM repair_issues ri
    JOIN repair_tickets t ON t.id = ri.repair_ticket_id
    WHERE ri.knowledge_entry_id IS NULL
      AND ri.suggestion_dismissed_at IS NULL
      AND t.repair_status <> 'CANCELLED'
    ORDER BY ri.created_at DESC
    LIMIT ${s.GROUP_CANDIDATE_LIMIT}
  `);
  if (candidates.length < s.GROUP_MIN_SIZE) return [];

  const ids = candidates.map((c) => c.id);
  // The text is the description without its "[System] " prefix, plus "What fixed it"
  const pairs = await prisma.$queryRaw<Pair[]>(Prisma.sql`
    WITH c AS (
      SELECT ri.id, ri.category_id,
             regexp_replace(ri.description, '^\\[[^]]*\\]\\s*', '') || ' ' || coalesce(ri.resolution_note, '') AS text
      FROM repair_issues ri
      WHERE ri.id = ANY(${ids}::uuid[])
    )
    SELECT a.id::text AS a, b.id::text AS b
    FROM c a
    JOIN c b
      ON a.id < b.id
     AND a.category_id IS NOT DISTINCT FROM b.category_id
     AND similarity(a.text, b.text) >= ${s.GROUP_SIMILARITY}
  `);

  return groupPairs(
    candidates.map((c) => ({ id: c.id, createdAt: c.created_at })),
    pairs,
  ).slice(0, limit);
}

/** "[Brakes] Wear and tear: squeal" → "Wear and tear: squeal", for symptoms prefill (AC-33). */
export function withoutSystemPrefix(description: string) {
  return description.replace(/^\[[^\]]*\]\s*/, '');
}
