import { PrismaClient, UserRole, SystemType } from '@prisma/client';
import * as argon2 from 'argon2';

export async function seedUsers(prisma: PrismaClient) {
  console.log('Creating partitioned admin users...');

  const adminPasswordHash = await argon2.hash('admin1234');

  // 1. BMS Admin
  const bmsAdminUser = await prisma.user.upsert({
    where: { email: 'bms.admin@welinc.com' },
    update: { emailVerified: true },
    create: {
      name: 'Bernardo Mendoza',
      email: 'bms.admin@welinc.com',
      emailVerified: true,
      passwordHash: adminPasswordHash,
    },
  });

  await prisma.userRoleAssignment.upsert({
    where: {
      userId_role_system: {
        userId: bmsAdminUser.id,
        role: UserRole.ADMIN,
        system: SystemType.BMS,
      },
    },
    update: {},
    create: {
      userId: bmsAdminUser.id,
      role: UserRole.ADMIN,
      system: SystemType.BMS,
    },
  });

  // 2. VRMS Admin
  const vrmsAdminUser = await prisma.user.upsert({
    where: { email: 'vrms.admin@welinc.com' },
    update: { emailVerified: true },
    create: {
      name: 'Victor Ramos',
      email: 'vrms.admin@welinc.com',
      emailVerified: true,
      passwordHash: adminPasswordHash,
    },
  });

  await prisma.userRoleAssignment.upsert({
    where: {
      userId_role_system: {
        userId: vrmsAdminUser.id,
        role: UserRole.ADMIN,
        system: SystemType.VRMS,
      },
    },
    update: {},
    create: {
      userId: vrmsAdminUser.id,
      role: UserRole.ADMIN,
      system: SystemType.VRMS,
    },
  });

  // 3. VMMS Admin
  const vmmsAdminUser = await prisma.user.upsert({
    where: { email: 'vmms.admin@welinc.com' },
    update: { emailVerified: true },
    create: {
      name: 'Valerio Mercado',
      email: 'vmms.admin@welinc.com',
      emailVerified: true,
      passwordHash: adminPasswordHash,
    },
  });

  await prisma.userRoleAssignment.upsert({
    where: {
      userId_role_system: {
        userId: vmmsAdminUser.id,
        role: UserRole.ADMIN,
        system: SystemType.VMMS,
      },
    },
    update: {},
    create: {
      userId: vmmsAdminUser.id,
      role: UserRole.ADMIN,
      system: SystemType.VMMS,
    },
  });

  console.log('  Partitioned admin users created (BMS, VRMS, VMMS)');

  // 4. CS and Ops Users
  console.log('Creating Customer Service and Operations users...');
  const csPasswordHash = await argon2.hash('cs1234');
  const opsPasswordHash = await argon2.hash('ops1234');

  const csUser = await prisma.user.upsert({
    where: { email: 'cs.user@welinc.com' },
    update: { emailVerified: true },
    create: {
      name: 'Clara Reyes',
      email: 'cs.user@welinc.com',
      emailVerified: true,
      passwordHash: csPasswordHash,
    },
  });

  await prisma.userRoleAssignment.upsert({
    where: {
      userId_role_system: {
        userId: csUser.id,
        role: UserRole.CUSTOMER_SUPPORT,
        system: SystemType.BMS,
      },
    },
    update: {},
    create: {
      userId: csUser.id,
      role: UserRole.CUSTOMER_SUPPORT,
      system: SystemType.BMS,
    },
  });

  const opsUser = await prisma.user.upsert({
    where: { email: 'ops.user@welinc.com' },
    update: { emailVerified: true },
    create: {
      name: 'Oscar Santos',
      email: 'ops.user@welinc.com',
      emailVerified: true,
      passwordHash: opsPasswordHash,
    },
  });

  await prisma.userRoleAssignment.upsert({
    where: {
      userId_role_system: {
        userId: opsUser.id,
        role: UserRole.OPERATIONS,
        system: SystemType.BMS,
      },
    },
    update: {},
    create: {
      userId: opsUser.id,
      role: UserRole.OPERATIONS,
      system: SystemType.BMS,
    },
  });

  // 5. Mechanics
  console.log('Creating sample mechanics...');
  const mechanicPassword = await argon2.hash('mechanic1234');
  const mechEmails = [
    { email: 'mech.juan@welinc.com', name: 'Juan dela Cruz' },
    { email: 'mech.pedro@welinc.com', name: 'Pedro Santos' },
    { email: 'mech.rommel@welinc.com', name: 'Rommel Cruz' },
    { email: 'mech.isabel@welinc.com', name: 'Isabel Reyes' },
    { email: 'mech.carl@welinc.com', name: 'Carl Santos' },
  ];

  const mechanicsList: any[] = [];
  for (const m of mechEmails) {
    const user = await prisma.user.upsert({
      where: { email: m.email },
      update: { emailVerified: true },
      create: {
        name: m.name,
        email: m.email,
        emailVerified: true,
        passwordHash: mechanicPassword,
      },
    });

    for (const sys of [SystemType.VRMS, SystemType.VMMS]) {
      await prisma.userRoleAssignment.upsert({
        where: {
          userId_role_system: {
            userId: user.id,
            role: UserRole.MECHANIC,
            system: sys,
          },
        },
        update: {},
        create: {
          userId: user.id,
          role: UserRole.MECHANIC,
          system: sys,
        },
      });
    }

    const mech = await prisma.mechanic.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        name: user.name,
        isOutsourced: false,
      },
    });
    mechanicsList.push(mech);
  }

  // 6. Bulk seeding for pagination (60 users)
  console.log('Generating 60 additional mechanics/users with realistic names...');
  const firstNames = [
    'Danilo', 'Edgardo', 'Ramon', 'Arnel', 'Bernardo', 'Catalino', 'Dionisio', 'Juan', 'Pedro',
    'Rommel', 'Roberto', 'Generoso', 'Jaime', 'Manuel', 'Restituto', 'Reynaldo', 'Salvador',
    'Vicente', 'Wilfredo', 'Renato', 'Gregorio', 'Leopoldo', 'Rolando', 'Armando', 'Francisco',
    'Ernesto', 'Fernando', 'Mario', 'Antonio', 'Joseph', 'Alberto', 'Ricardo', 'Ferdinand',
    'Eduardo', 'Roger', 'Enrique', 'Luis', 'Carlos', 'Oscar', 'Winston', 'Benjamin'
  ];
  const lastNames = [
    'Santos', 'Ramos', 'Cruz', 'Gonzales', 'Reyes', 'Castro', 'Bulaon', 'Mendoza', 'Pascual',
    'Perez', 'Mercado', 'Dizon', 'Aquino', 'Bautista', 'Garcia', 'Torres', 'Tolentino',
    'Villanueva', 'dela Cruz', 'Ocampo', 'Espiritu', 'Panganiban', 'Soriano', 'Gomez', 'Lopez',
    'Castillo', 'Santiago', 'Sebastian', 'del Rosario', 'Valdez', 'Guzman', 'Corpuz'
  ];

  for (let i = 1; i <= 60; i++) {
    const firstName = firstNames[i % firstNames.length];
    const lastName = lastNames[(i * 3) % lastNames.length];
    const name = `${firstName} ${lastName}`;
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase().replace(/\s+/g, '')}${i}@welinc.com`;

    const user = await prisma.user.upsert({
      where: { email },
      update: { emailVerified: true },
      create: {
        name,
        email,
        emailVerified: true,
        passwordHash: mechanicPassword,
      },
    });

    for (const sys of [SystemType.VRMS, SystemType.VMMS]) {
      await prisma.userRoleAssignment.upsert({
        where: {
          userId_role_system: {
            userId: user.id,
            role: UserRole.MECHANIC,
            system: sys,
          },
        },
        update: {},
        create: {
          userId: user.id,
          role: UserRole.MECHANIC,
          system: sys,
        },
      });
    }

    await prisma.mechanic.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        name: user.name,
        isOutsourced: i % 5 === 0,
      },
    });
  }

  console.log('  All seed users and mechanics successfully processed.\n');
}
