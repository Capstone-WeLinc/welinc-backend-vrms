// The seed people VRMS links its rows to (spec 0006, AC-14). Accounts live in welinc-auth; its
// prisma/seeds/people.json is the one list of seed people, and people.json here is a byte for
// byte copy. After pulling welinc-auth, check the copy from the workspace root with:
//   npm --prefix welinc-auth run seed:check -- welinc-backend-vrms/prisma/seeds/people.json
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type ManifestPerson = {
  id: string;
  email: string;
  name: string;
  group: string;
  state: string;
  roles: { system: string; role: string }[];
};

const MANIFEST_PATH = join(__dirname, 'people.json');

function loadPeople(): ManifestPerson[] {
  let text: string;
  try {
    text = readFileSync(MANIFEST_PATH, 'utf8');
  } catch {
    throw new Error(
      `No seed manifest at ${MANIFEST_PATH}. Copy welinc-auth/prisma/seeds/people.json there.`,
    );
  }
  try {
    return (JSON.parse(text) as { people: ManifestPerson[] }).people;
  } catch (e) {
    throw new Error(
      `${MANIFEST_PATH} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Every manifest person, in id order. */
export const MANIFEST_PEOPLE: ManifestPerson[] = loadPeople();

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const SEED_IDS = {
  bmsAdmin: id(1),
  vrmsAdmin: id(2),
  vmmsAdmin: id(3),
  csUser: id(4),
  opsUser: id(5),
  chief: id(20),
};

export type SeedPerson = { id: string; email: string; name: string };

const BY_ID = new Map(MANIFEST_PEOPLE.map((p) => [p.id, p]));
const BY_EMAIL = new Map(MANIFEST_PEOPLE.map((p) => [p.email, p]));

function seedPerson(personId: string): SeedPerson {
  const p = BY_ID.get(personId);
  if (!p) throw new Error(`Seed person ${personId} is not in people.json`);
  return { id: p.id, email: p.email, name: p.name };
}

const inGroup = (group: string): SeedPerson[] =>
  MANIFEST_PEOPLE.filter((p) => p.group === group).map((p) => seedPerson(p.id));

export const VRMS_ADMIN: SeedPerson = seedPerson(SEED_IDS.vrmsAdmin);
export const CHIEF: SeedPerson = seedPerson(SEED_IDS.chief);
/** The mechanics with a demo login (`group: mechanic`). */
export const NAMED_MECHANICS: SeedPerson[] = inGroup('mechanic');
/** More mechanics so the user list has pages (`group: bulk`). */
export const BULK_MECHANICS: SeedPerson[] = inGroup('bulk');

/** The person's VRMS role code, or null when they hold none. */
export function vrmsRole(p: Pick<ManifestPerson, 'roles'>): string | null {
  return p.roles.find((r) => r.system === 'VRMS')?.role ?? null;
}

/** The actor columns of an audit or knowledge change row, as the API writes them (spec 0010). */
export function seedActor(email: string) {
  const person = BY_EMAIL.get(email);
  return {
    actorUserId: person?.id ?? null,
    actorName: person?.name ?? email,
    actorEmail: email,
    actorRole: person ? vrmsRole(person) : null,
  };
}
