import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../shared/prisma.service';
import type { AuthUser } from '../auth/account-check';
import { whoName } from '../modules/vrms/audit-events';
import { SETTINGS_CATALOG } from './catalog';
import type { UpdateSettingsDto } from './dto/update-settings.dto';
import { effectiveValue, planSave } from './settings-rules';

export const STALE_SETTINGS =
  'Settings changed since you loaded them. Reload and try again.';

/**
 * The settings API (spec 0012, AC-5 to AC-9). It reads and writes the stored rows directly; each
 * replica's cache follows through settings_state.version (SettingsService, AC-4).
 */
@Injectable()
export class SettingsAdminService {
  private readonly logger = new Logger(SettingsAdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Every catalog entry with its effective value and its last change (Value sourcing). */
  async view() {
    const [state, rows, latest] = await Promise.all([
      this.prisma.settingsState.findUniqueOrThrow({
        where: { id: 1 },
        select: { version: true },
      }),
      this.prisma.appSetting.findMany({ select: { key: true, value: true } }),
      this.prisma.settingChange.findMany({
        distinct: ['key'],
        orderBy: [{ key: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: {
          key: true,
          createdAt: true,
          actorName: true,
          actorEmail: true,
        },
      }),
    ]);
    const stored = new Map(rows.map((r) => [r.key, r.value as unknown]));
    const lastChange = new Map(latest.map((c) => [c.key, c]));

    const settings = SETTINGS_CATALOG.map((entry) => {
      const raw = stored.get(entry.key);
      const { value, valid } = effectiveValue(entry, raw);
      const change = lastChange.get(entry.key);
      return {
        key: entry.key,
        kind: entry.kind,
        group: entry.group,
        label: entry.label,
        description: entry.description,
        type: entry.type,
        unit: entry.kind === 'value' ? entry.unit : null,
        min: entry.kind === 'value' ? entry.min : null,
        max: entry.kind === 'value' ? entry.max : null,
        default: entry.default,
        value,
        isDefault: raw === undefined || !valid,
        hides: entry.kind === 'module' ? entry.hides : [],
        requires:
          entry.kind === 'module' && 'requires' in entry
            ? (entry.requires as readonly string[])
            : [],
        module: entry.kind === 'value' ? entry.module : null,
        updatedAt: change?.createdAt ?? null,
        updatedBy:
          change && (change.actorName || change.actorEmail)
            ? { name: change.actorName, email: change.actorEmail }
            : null,
      };
    });

    return { version: state.version, settings };
  }

  /**
   * All or nothing, under a row lock on the version (AC-5). The order is the spec's: the DTO
   * shape, then the version (409), then the catalog rules (400).
   */
  async update(dto: UpdateSettingsDto, actor: AuthUser) {
    const applied = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ version: number }[]>`
        SELECT version FROM settings_state WHERE id = 1 FOR UPDATE
      `;
      if (!locked || locked.version !== dto.version) {
        throw new ConflictException({
          statusCode: 409,
          message: STALE_SETTINGS,
          version: locked?.version ?? null,
        });
      }

      // `before` comes from the stored rows read under the lock, never a replica's cache
      const rows = await tx.appSetting.findMany({
        select: { key: true, value: true },
      });
      const plan = planSave(
        dto.changes,
        dto.note,
        new Map(rows.map((r) => [r.key, r.value as unknown])),
      );

      for (const change of plan.changes) {
        if (change.write === 'delete') {
          await tx.appSetting.delete({ where: { key: change.key } });
        } else {
          const value = change.write.value as Prisma.InputJsonValue;
          await tx.appSetting.upsert({
            where: { key: change.key },
            create: { key: change.key, value, updatedByUserId: actor.sub },
            update: { value, updatedByUserId: actor.sub },
          });
        }
      }

      const logged = plan.changes.filter((c) => c.logged);
      if (plan.changes.length === 0) return 0;

      // The actor comes from the token, never the body (Value sourcing)
      if (logged.length > 0) {
        await tx.settingChange.createMany({
          data: logged.map((c) => ({
            key: c.key,
            before: c.before,
            after: c.after,
            action: c.action,
            actorUserId: actor.sub,
            actorName: whoName(actor),
            actorEmail: actor.email.slice(0, 255),
            note: plan.note,
          })),
        });
      }
      await tx.settingsState.update({
        where: { id: 1 },
        data: { version: { increment: 1 } },
      });
      return logged.length;
    });

    if (applied > 0) {
      this.logger.log(`Settings: ${applied} values changed by ${actor.email}`);
    }
    return this.view();
  }
}
