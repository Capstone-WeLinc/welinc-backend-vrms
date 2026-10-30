import { PrismaClient } from '@prisma/client';

/**
 * Clears every stored setting and its history, so a seeded database runs on the catalog
 * defaults (spec 0012, AC-29). Production never runs the seed.
 */
export async function seedSettings(prisma: PrismaClient) {
  await prisma.$transaction([
    prisma.settingChange.deleteMany({}),
    prisma.appSetting.deleteMany({}),
    // Every running replica reloads on its next request
    prisma.settingsState.update({
      where: { id: 1 },
      data: { version: { increment: 1 } },
    }),
  ]);
  console.log('Settings reset to the catalog defaults');
}
