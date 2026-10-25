// Seeded random helpers, so one SEED value always rebuilds the same data.
// Run `SEED=1234 npm run seed` to repeat a run (dates stay relative to today); without it a fresh seed is picked and printed.

export const SEED = Number(
  process.env['SEED'] ?? Math.floor(Math.random() * 1_000_000),
);

// mulberry32: small, fast and good enough for test data
let state = SEED >>> 0;
export function random() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const int = (min: number, max: number) =>
  Math.floor(random() * (max - min + 1)) + min;
export const between = (min: number, max: number) =>
  min + random() * (max - min);
export const chance = (p: number) => random() < p;
export const pick = <T>(items: readonly T[]): T =>
  items[Math.floor(random() * items.length)];

export function weighted<T>(
  items: readonly T[],
  weight: (item: T) => number,
): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= weight(item);
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

export function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Roughly normal, clamped: most values near the middle of [min, max]. */
export function around(min: number, max: number) {
  return min + ((random() + random() + random()) / 3) * (max - min);
}

/** A random UUID from the seeded generator (v4 layout), so ids repeat with the seed too. */
export function uuid() {
  const hex = Array.from({ length: 32 }, () =>
    Math.floor(random() * 16).toString(16),
  );
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// ── Time (the garages run on Manila time, UTC+8) ─────────────────────────────

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
const MANILA = 8 * HOUR;

/** The Manila wall clock hour of an instant, 0 to 23.99. */
export const manilaHour = (t: number) =>
  ((((t + MANILA) % DAY) + DAY) % DAY) / HOUR;

/**
 * Moves an instant to a random minute of the shop day (07:30 to 17:00 Manila). A Sunday moves to
 * Monday, and anything that would land in the future moves back to the last shop day before now.
 */
export function duringShopHours(t: number) {
  const latest = Date.now() - HOUR;
  let startOfDay = t - manilaHour(t) * HOUR;
  if (new Date(startOfDay + MANILA).getUTCDay() === 0) startOfDay += DAY;
  let at = startOfDay + between(7.5, 17) * HOUR;
  while (at > latest) {
    startOfDay -= DAY;
    if (new Date(startOfDay + MANILA).getUTCDay() === 0) startOfDay -= DAY;
    at = startOfDay + between(7.5, 17) * HOUR;
  }
  return at;
}

/** Adds working hours, counting only 08:00 to 17:00 Manila, Monday to Saturday. */
export function addWorkHours(t: number, hours: number) {
  let left = hours * HOUR;
  let now = t;
  for (let guard = 0; left > 0 && guard < 400; guard++) {
    const h = manilaHour(now);
    const weekday = new Date(now + MANILA).getUTCDay();
    if (weekday === 0 || h >= 17) {
      now += (24 - h + 8) * HOUR; // next day 08:00
      continue;
    }
    if (h < 8) {
      now += (8 - h) * HOUR;
      continue;
    }
    const step = Math.min(left, (17 - h) * HOUR);
    now += step;
    left -= step;
  }
  return now;
}

/** "YYYYMMDD" of the Manila date. */
export function manilaDateKey(t: number) {
  return new Date(t + MANILA).toISOString().slice(0, 10).replace(/-/g, '');
}

/** Peso amount rounded to the nearest `step` (10 by default), as shops quote. */
export const peso = (value: number, step = 10) =>
  Math.round(value / step) * step;

/** Hours rounded to quarter hours, the step the "Hours spent" field allows. */
export const quarter = (value: number) =>
  Math.max(0.25, Math.round(value * 4) / 4);
