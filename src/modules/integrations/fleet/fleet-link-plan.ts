import type { FleetGarage, FleetVehicle } from './vmms-fleet.client';

// Spec 0029 (child 0001), AC-1: the one time link, as a pure plan. Garages match by name and
// trucks by plate, both trimmed and case insensitive. A row already linked keeps its link, so a
// second run plans nothing new.

export type LocalGarage = {
  id: string;
  name: string;
  vmmsGarageId: string | null;
  isActive: boolean;
  tickets: number;
};

export type LocalVehicle = {
  id: string;
  plateNumber: string;
  vmmsVehicleId: string | null;
  isActive: boolean;
  tickets: number;
};

export type Match<L, R> = { local: L; remote: R };
/** Two or more VRMS rows that would claim one VMMS record. */
export type DoubleClaim = { key: string; vmmsId: string; localIds: string[] };

export type LinkPlan = {
  garages: {
    matches: Match<LocalGarage, FleetGarage>[];
    /** VRMS rows with no VMMS record: archived on confirm (only the ones still active). */
    unmatched: LocalGarage[];
    /** VMMS records VRMS lacks: created on confirm. */
    missing: FleetGarage[];
    doubleClaims: DoubleClaim[];
  };
  vehicles: {
    matches: Match<LocalVehicle, FleetVehicle>[];
    unmatched: LocalVehicle[];
    missing: FleetVehicle[];
    doubleClaims: DoubleClaim[];
  };
};

export const matchKey = (value: string) => value.trim().toLowerCase();

function plan<L extends { id: string }, R extends { id: string }>(
  locals: L[],
  remotes: R[],
  localKey: (l: L) => string,
  remoteKey: (r: R) => string,
  linkedTo: (l: L) => string | null,
) {
  const byId = new Map(remotes.map((r) => [r.id, r]));
  const byKey = new Map(remotes.map((r) => [matchKey(remoteKey(r)), r]));
  const claims = new Map<string, L[]>();
  const unmatched: L[] = [];
  for (const local of locals) {
    const linked = linkedTo(local);
    // Already linked: keep that link (a rerun). A link to a record VMMS no longer lists is left
    // to the reconcile, which deactivates it.
    const remote = linked
      ? byId.get(linked)
      : byKey.get(matchKey(localKey(local)));
    if (linked && !remote) continue;
    if (!remote) {
      unmatched.push(local);
      continue;
    }
    claims.set(remote.id, [...(claims.get(remote.id) ?? []), local]);
  }
  const matches: Match<L, R>[] = [];
  const doubleClaims: DoubleClaim[] = [];
  for (const [vmmsId, claimers] of claims) {
    const remote = byId.get(vmmsId)!;
    if (claimers.length > 1) {
      doubleClaims.push({
        key: remoteKey(remote),
        vmmsId,
        localIds: claimers.map((c) => c.id),
      });
    } else {
      matches.push({ local: claimers[0], remote });
    }
  }
  const missing = remotes.filter((r) => !claims.has(r.id));
  return { matches, unmatched, missing, doubleClaims };
}

export function planFleetLink(
  local: { garages: LocalGarage[]; vehicles: LocalVehicle[] },
  remote: { garages: FleetGarage[]; vehicles: FleetVehicle[] },
): LinkPlan {
  return {
    garages: plan(
      local.garages,
      remote.garages,
      (g) => g.name,
      (g) => g.name,
      (g) => g.vmmsGarageId,
    ),
    vehicles: plan(
      local.vehicles,
      remote.vehicles,
      (v) => v.plateNumber,
      (v) => v.plateNumber,
      (v) => v.vmmsVehicleId,
    ),
  };
}

export const hasDoubleClaims = (p: LinkPlan) =>
  p.garages.doubleClaims.length + p.vehicles.doubleClaims.length > 0;

/** The plan as the script prints it. */
export function describeLinkPlan(p: LinkPlan): string[] {
  const lines: string[] = [];
  const section = (
    title: string,
    part: LinkPlan['garages'] | LinkPlan['vehicles'],
    label: (x: { name?: string; plateNumber?: string }) => string,
  ) => {
    lines.push(`${title}:`);
    lines.push(`  link ${part.matches.length}`);
    for (const m of part.matches) {
      lines.push(`    ${label(m.local)} -> VMMS ${m.remote.id}`);
    }
    const archive = part.unmatched.filter((u) => u.isActive);
    lines.push(`  archive ${archive.length} (not in VMMS; tickets kept)`);
    for (const u of archive) {
      lines.push(
        `    ${label(u)} (${u.tickets} ticket${u.tickets === 1 ? '' : 's'})`,
      );
    }
    lines.push(`  add ${part.missing.length} from VMMS`);
    for (const m of part.missing) lines.push(`    ${label(m)}`);
    for (const d of part.doubleClaims) {
      lines.push(
        `  STOP: ${d.localIds.length} VRMS rows match VMMS "${d.key}" (${d.vmmsId}): ${d.localIds.join(', ')}`,
      );
    }
  };
  section('Garages', p.garages, (x) => x.name ?? '');
  section('Trucks', p.vehicles, (x) => x.plateNumber ?? '');
  return lines;
}
