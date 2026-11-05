/**
 * Sovereign Currencies & World Accounting Unit (GDD §3.2).
 *
 * - Each of the 5 sectors chooses a unique sovereign currency from the 16 canonical
 *   national currencies (no currency unions; free-floating FX rates).
 * - Hryvnia (₴, UAH) MUST always be present in every season (GDD §1.2, §3.2).
 * - Ruble is explicitly excluded from the currency catalog (GDD §3.2).
 * - The Outer World trades in World Currency Units (WCU / МРЕ).
 */

export type CurrencyCode =
  | "UAH" // Гривна ₴ (mandatory in every season)
  | "PLN" // Злотый zł
  | "KR"  // Крона kr
  | "TLR" // Талер ₮
  | "FLR" // Флорин ƒ
  | "DUC" // Дукат ◈
  | "LIR" // Лира ₺
  | "MRK" // Марка ℳ
  | "LEV" // Лев лв
  | "LEU" // Лей L
  | "DIN" // Динар د
  | "FRK" // Франк ₣
  | "ESC" // Эскудо $
  | "DRX" // Драхма ₯
  | "BRL" // Реал R$
  | "PES"; // Песо ₱

export type AnyCurrencyCode = CurrencyCode | "WCU";

export interface CurrencySpec {
  readonly code: AnyCurrencyCode;
  readonly symbol: string;
  readonly nameRu: string;
  readonly nameEn: string;
  readonly mandatoryInSeason: boolean;
}

export const WORLD_CURRENCY: CurrencySpec = {
  code: "WCU",
  symbol: "МРЕ",
  nameRu: "Мировая расчётная единица",
  nameEn: "World Currency Unit",
  mandatoryInSeason: true,
};

/**
 * Canonical 16 selectable national currencies from GDD §3.2:
 * Гривна (₴ — mandatory), злотый, крона, талер, флорин, дукат, лира, марка,
 * лев, лей, динар, франк, эскудо, драхма, реал, песо.
 */
export const NATIONAL_CURRENCIES: readonly CurrencySpec[] = [
  { code: "UAH", symbol: "₴", nameRu: "Гривна", nameEn: "Hryvnia", mandatoryInSeason: true },
  { code: "PLN", symbol: "zł", nameRu: "Злотый", nameEn: "Zloty", mandatoryInSeason: false },
  { code: "KR", symbol: "kr", nameRu: "Крона", nameEn: "Krona", mandatoryInSeason: false },
  { code: "TLR", symbol: "₮", nameRu: "Талер", nameEn: "Thaler", mandatoryInSeason: false },
  { code: "FLR", symbol: "ƒ", nameRu: "Флорин", nameEn: "Florin", mandatoryInSeason: false },
  { code: "DUC", symbol: "◈", nameRu: "Дукат", nameEn: "Ducat", mandatoryInSeason: false },
  { code: "LIR", symbol: "₺", nameRu: "Лира", nameEn: "Lira", mandatoryInSeason: false },
  { code: "MRK", symbol: "ℳ", nameRu: "Марка", nameEn: "Mark", mandatoryInSeason: false },
  { code: "LEV", symbol: "лв", nameRu: "Лев", nameEn: "Lev", mandatoryInSeason: false },
  { code: "LEU", symbol: "L", nameRu: "Лей", nameEn: "Leu", mandatoryInSeason: false },
  { code: "DIN", symbol: "د", nameRu: "Динар", nameEn: "Dinar", mandatoryInSeason: false },
  { code: "FRK", symbol: "₣", nameRu: "Франк", nameEn: "Franc", mandatoryInSeason: false },
  { code: "ESC", symbol: "Esc", nameRu: "Эскудо", nameEn: "Escudo", mandatoryInSeason: false },
  { code: "DRX", symbol: "₯", nameRu: "Драхма", nameEn: "Drachma", mandatoryInSeason: false },
  { code: "BRL", symbol: "R$", nameRu: "Реал", nameEn: "Real", mandatoryInSeason: false },
  { code: "PES", symbol: "₱", nameRu: "Песо", nameEn: "Peso", mandatoryInSeason: false },
] as const;

/** Default currency assignment for headless 5-region simulations (Sector 1 = UAH ₴). */
export const DEFAULT_SECTOR_CURRENCIES: readonly [
  CurrencyCode,
  CurrencyCode,
  CurrencyCode,
  CurrencyCode,
  CurrencyCode,
] = ["UAH", "PLN", "KR", "FLR", "DUC"];

const CURRENCY_BY_CODE = new Map<AnyCurrencyCode, CurrencySpec>([
  [WORLD_CURRENCY.code, WORLD_CURRENCY],
  ...NATIONAL_CURRENCIES.map((c): [AnyCurrencyCode, CurrencySpec] => [c.code, c]),
]);

export function getCurrencySpec(code: AnyCurrencyCode): CurrencySpec {
  const hit = CURRENCY_BY_CODE.get(code);
  if (!hit) throw new Error(`Unknown currency code: ${code}`);
  return hit;
}

/**
 * Validates a 5-region currency assignment:
 * - No duplicates among active regions;
 * - When all 5 slots are assigned (or headless simulation runs), UAH (₴) must be present.
 */
export function validateSeasonCurrencies(
  assigned: readonly (CurrencyCode | null)[],
  requireHryvniaWhenFull = true
): { valid: boolean; reason?: string } {
  const active = assigned.filter((c): c is CurrencyCode => c !== null);
  const unique = new Set(active);
  if (unique.size !== active.length) {
    return { valid: false, reason: "Duplicate national currency selected in the same world" };
  }
  for (const code of active) {
    if (!CURRENCY_BY_CODE.has(code) || code === ("WCU" as CurrencyCode)) {
      return { valid: false, reason: `Invalid national currency code: ${code}` };
    }
  }
  if (requireHryvniaWhenFull && active.length === 5 && !unique.has("UAH")) {
    return { valid: false, reason: "Hryvnia (UAH ₴) must be present in every 5-region season" };
  }
  return { valid: true };
}

export function listAvailableCurrencies(taken: Iterable<CurrencyCode>): CurrencySpec[] {
  const used = new Set<string>(taken);
  return NATIONAL_CURRENCIES.filter((c) => !used.has(c.code));
}
