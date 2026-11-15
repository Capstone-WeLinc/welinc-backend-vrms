import { Prisma } from '@prisma/client';

/**
 * Clears every stored setting and its history, so a seeded database runs on the catalog
 * defaults (spec 0012, AC-29). The caller runs it inside a transaction, so every running
 * replica sees the reset and its version bump together. Production runs it only through
 * `--reference`, on an empty database.
 */
export async function seedSettings(prisma: Prisma.TransactionClient) {
  await prisma.settingChange.deleteMany({});
  await prisma.appSetting.deleteMany({});
  // Every running replica reloads on its next request
  await prisma.settingsState.update({
    where: { id: 1 },
    data: { version: { increment: 1 } },
  });
  console.log('Settings reset to the catalog defaults');
}
