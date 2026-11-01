// Fixed ids for the people seeded in both welinc-auth and welinc-backend-vrms (spec 0009, AC-22),
// so a VRMS Mechanic.authUserId equals the welinc-auth User.id after both seeds run.
// Keep it in step with welinc-auth/prisma/seeds/shared-ids.ts (only this line differs).

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

export const VRMS_ADMIN: SeedPerson = {
  id: SEED_IDS.vrmsAdmin,
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
};

export const CHIEF: SeedPerson = {
  id: SEED_IDS.chief,
  email: 'vrms.chief@welinc.com',
  name: 'Ramon Villanueva',
};

// The mechanics with a demo login
export const NAMED_MECHANICS: SeedPerson[] = [
  { id: id(11), email: 'mech.juan@welinc.com', name: 'Juan dela Cruz' },
  { id: id(12), email: 'mech.pedro@welinc.com', name: 'Pedro Santos' },
  { id: id(13), email: 'mech.rommel@welinc.com', name: 'Rommel Cruz' },
  { id: id(14), email: 'mech.isabel@welinc.com', name: 'Isabel Reyes' },
  { id: id(15), email: 'mech.carl@welinc.com', name: 'Carl Santos' },
];

// 60 more mechanics so the user list has pages
const FIRST_NAMES = [
  'Danilo',
  'Edgardo',
  'Ramon',
  'Arnel',
  'Bernardo',
  'Catalino',
  'Dionisio',
  'Juan',
  'Pedro',
  'Rommel',
  'Roberto',
  'Generoso',
  'Jaime',
  'Manuel',
  'Restituto',
  'Reynaldo',
  'Salvador',
  'Vicente',
  'Wilfredo',
  'Renato',
  'Gregorio',
  'Leopoldo',
  'Rolando',
  'Armando',
  'Francisco',
  'Ernesto',
  'Fernando',
  'Mario',
  'Antonio',
  'Joseph',
  'Alberto',
  'Ricardo',
  'Ferdinand',
  'Eduardo',
  'Roger',
  'Enrique',
  'Luis',
  'Carlos',
  'Oscar',
  'Winston',
  'Benjamin',
];
const LAST_NAMES = [
  'Santos',
  'Ramos',
  'Cruz',
  'Gonzales',
  'Reyes',
  'Castro',
  'Bulaon',
  'Mendoza',
  'Pascual',
  'Perez',
  'Mercado',
  'Dizon',
  'Aquino',
  'Bautista',
  'Garcia',
  'Torres',
  'Tolentino',
  'Villanueva',
  'dela Cruz',
  'Ocampo',
  'Espiritu',
  'Panganiban',
  'Soriano',
  'Gomez',
  'Lopez',
  'Castillo',
  'Santiago',
  'Sebastian',
  'del Rosario',
  'Valdez',
  'Guzman',
  'Corpuz',
];

export const BULK_MECHANICS: SeedPerson[] = Array.from(
  { length: 60 },
  (_, k) => {
    const i = k + 1;
    const firstName = FIRST_NAMES[i % FIRST_NAMES.length];
    const lastName = LAST_NAMES[(i * 3) % LAST_NAMES.length];
    return {
      id: id(1000 + i),
      name: `${firstName} ${lastName}`,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase().replace(/\s+/g, '')}${i}@welinc.com`,
    };
  },
);

// The VRMS role each seeded person holds in welinc-auth's seed
const ROLE_BY_EMAIL = new Map<string, string>([
  [VRMS_ADMIN.email, 'ADMIN'],
  [CHIEF.email, 'CHIEF_MECHANIC'],
  ...[...NAMED_MECHANICS, ...BULK_MECHANICS].map(
    (p) => [p.email, 'MECHANIC'] as [string, string],
  ),
]);
const PERSON_BY_EMAIL = new Map(
  [VRMS_ADMIN, CHIEF, ...NAMED_MECHANICS, ...BULK_MECHANICS].map((p) => [
    p.email,
    p,
  ]),
);

/** The actor columns of an audit or knowledge change row, as the API writes them (spec 0010). */
export function seedActor(email: string) {
  const person = PERSON_BY_EMAIL.get(email);
  return {
    actorUserId: person?.id ?? null,
    actorName: person?.name ?? email,
    actorEmail: email,
    actorRole: ROLE_BY_EMAIL.get(email) ?? null,
  };
}
