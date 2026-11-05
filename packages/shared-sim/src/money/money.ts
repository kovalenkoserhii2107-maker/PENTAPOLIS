/**
 * Money arithmetic for PENTAPOLIS (GDD §3.3).
 *
 * Every amount is a `bigint` in minor units of its currency (kopiyky / cents):
 * 1 unit of currency = 100 minor units. Floating-point numbers never hold money.
 *
 * Behavioural quantities (rates, shares, exchange rates, indices) may be ordinary
 * numbers; they are converted to an integer "parts per billion" factor right before
 * they touch an amount, so the money path is pure integer arithmetic and fully
 * deterministic across machines.
 */

export type Money = bigint;

/** Minor units per currency unit (all PENTAPOLIS currencies have 100). */
export const MINOR_PER_UNIT = 100n;

/** Fixed-point scale for rates applied to money: 1.0 === 1_000_000_000n. */
export const RATE_SCALE = 1_000_000_000n;

/** Converts a whole/fractional currency amount from data tables into minor units. */
export function money(units: number): Money {
  if (!Number.isFinite(units)) throw new RangeError(`money(): not a finite number: ${units}`);
  return BigInt(Math.round(units * 100));
}

/** Minor units -> currency units as a number (display / statistics only). */
export function toUnits(m: Money): number {
  return Number(m) / 100;
}

/** A behavioural rate (e.g. 0.18) as a fixed-point bigint factor. */
export function ppb(rate: number): bigint {
  if (!Number.isFinite(rate)) throw new RangeError(`ppb(): not a finite number: ${rate}`);
  return BigInt(Math.round(rate * 1e9));
}

/** Integer division rounded half away from zero. */
export function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError("divRound(): division by zero");
  if (d < 0n) { n = -n; d = -d; }
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= d) return n < 0n ? q - 1n : q + 1n;
  return q;
}

/** amount x rate, rounded to the nearest minor unit. */
export function mulRate(amount: Money, rate: number): Money {
  return divRound(amount * ppb(rate), RATE_SCALE);
}

/** amount x num / den with rounding (exact rational scaling). */
export function scale(amount: Money, num: bigint, den: bigint): Money {
  return divRound(amount * num, den);
}

/** amount / divisor as a float ratio (statistics only). */
export function ratio(a: Money, b: Money): number {
  if (b === 0n) return 0;
  return Number(a) / Number(b);
}

export function absBig(a: bigint): bigint {
  return a < 0n ? -a : a;
}

export function maxBig(...xs: bigint[]): bigint {
  let m = xs[0] ?? 0n;
  for (const x of xs) if (x > m) m = x;
  return m;
}

export function minBig(...xs: bigint[]): bigint {
  let m = xs[0] ?? 0n;
  for (const x of xs) if (x < m) m = x;
  return m;
}

export function sumBig(xs: readonly bigint[]): bigint {
  let s = 0n;
  for (const x of xs) s += x;
  return s;
}

/**
 * Splits `total` into parts proportional to non-negative `weights` so that the parts
 * add up to `total` exactly (largest-remainder method, ties broken by index).
 * Used wherever one aggregate flow is booked per household class or per region.
 */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  const n = weights.length;
  if (n === 0) return [];
  const w = weights.map((x) => (x > 0 && Number.isFinite(x) ? ppb(x) : 0n));
  const wSum = sumBig(w);
  if (wSum === 0n) {
    const out = new Array<Money>(n).fill(0n);
    out[0] = total;
    return out;
  }
  const sign = total < 0n ? -1n : 1n;
  const abs = total * sign;
  const parts: Money[] = [];
  const rems: { i: number; r: bigint }[] = [];
  let assigned = 0n;
  for (let i = 0; i < n; i++) {
    const num = abs * w[i]!;
    const q = num / wSum;
    parts.push(q);
    rems.push({ i, r: num % wSum });
    assigned += q;
  }
  let left = abs - assigned;
  rems.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (let k = 0; left > 0n; k = (k + 1) % n, left--) parts[rems[k]!.i]! += 1n;
  return parts.map((p) => p * sign);
}

/** Formats minor units as "1 234 567.89" (no currency symbol). */
export function formatMoney(m: Money): string {
  const neg = m < 0n;
  const a = neg ? -m : m;
  const whole = (a / MINOR_PER_UNIT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const frac = (a % MINOR_PER_UNIT).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
