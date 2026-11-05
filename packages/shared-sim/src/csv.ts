/**
 * Zero-dependency RFC-4180 CSV parser & typed field extractors for PENTAPOLIS sheets.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const n = text.length;

  for (let i = 0; i < n; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // ignore CR in CRLF
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parses a float cell, stripping `$`, `,`, `%`, spaces if needed. */
export function parseNum(raw: string | undefined, fallback = 0): number {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "-" || trimmed.startsWith("#")) return fallback;
  const cleaned = trimmed.replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}

export interface TileFootprint {
  width: number;
  depth: number;
  isLine: boolean;
  isUnderground: boolean;
  raw: string;
}

/**
 * Parses catalog footprint strings like `"30x20"`, `"2x2 lot (one house)"`,
 * `"4x4 to 12x12"`, `"line, 2 tiles wide"`, `"line, underground"`, `"4x2 entrances"`.
 */
export function parseFootprint(raw: string | undefined): TileFootprint {
  const text = (raw ?? "").trim();
  const lower = text.toLowerCase();
  const isUnderground = lower.includes("underground");
  if (lower.startsWith("line")) {
    const widthMatch = /(\d+)\s*tiles?\s*wide/i.exec(text);
    const w = widthMatch ? parseInt(widthMatch[1]!, 10) : 1;
    return { width: w, depth: 1, isLine: true, isUnderground, raw: text };
  }
  const rectMatch = /(\d+)\s*x\s*(\d+)/i.exec(text);
  if (rectMatch) {
    return {
      width: parseInt(rectMatch[1]!, 10),
      depth: parseInt(rectMatch[2]!, 10),
      isLine: false,
      isUnderground,
      raw: text,
    };
  }
  return { width: 1, depth: 1, isLine: false, isUnderground, raw: text };
}

export interface MaterialRequirement {
  commodity: string;
  quantity: number;
}

/**
 * Canonical commodity name aliases used in formula/recipe strings across sheets.
 */
const MATERIAL_ALIASES: Readonly<Record<string, string>> = {
  "iron ore": "Iron Ore",
  "coal": "Coal",
  "crude oil": "Crude Oil",
  "limestone & granite": "Limestone & Granite",
  "limestone": "Limestone & Granite",
  "stone": "Limestone & Granite",
  "grain": "Grain",
  "timber": "Timber",
  "natural gas": "Natural Gas",
  "quartz & silica sand": "Quartz & Silica Sand",
  "quartz": "Quartz & Silica Sand",
  "steel": "Steel",
  "fuel & plastics": "Fuel & Plastics",
  "asphalt": "Fuel & Plastics",
  "fuel": "Fuel & Plastics",
  "fertilizers & polymers": "Fertilizers & Polymers",
  "cement": "Cement",
  "flour & food": "Flour & Food",
  "food": "Flour & Food",
  "lumber": "Lumber",
  "industrial machinery": "Industrial Machinery",
  "microchips": "Microchips",
  "consumer goods": "Consumer Goods",
  "construction prefabs": "Construction Prefabs",
  "prefabs": "Construction Prefabs",
  "auto components & engines": "Auto Components & Engines",
  "auto components": "Auto Components & Engines",
  "heavy transport vehicles": "Heavy Transport Vehicles",
  "economy car": "Economy Car",
  "mid-range car": "Mid-Range Car",
  "premium car": "Premium Car",
  "luxury goods": "Luxury Goods",
  "electricity": "Electricity",
};

export function normalizeCommodityName(raw: string): string {
  const clean = raw
    .replace(/\(.*?\)/g, "")
    .replace(/^fit-out:\s*/i, "")
    .trim();
  const hit = MATERIAL_ALIASES[clean.toLowerCase()];
  return hit ?? clean;
}

/**
 * Parses production recipe input strings like `"2x Iron Ore + 1x Coal"` or
 * `"10x Auto Components + 4x Microchips + 2x Luxury Goods + 2x Lumber"`.
 */
export function parseRecipeInputs(raw: string | undefined): MaterialRequirement[] {
  const text = (raw ?? "").trim();
  if (!text || /^none\b/i.test(text)) return [];
  const parts = text.split("+").map((p) => p.trim()).filter(Boolean);
  const out: MaterialRequirement[] = [];
  for (const part of parts) {
    const m = /^(\d+(?:\.\d+)?)\s*x\s+(.+)$/i.exec(part);
    if (m) {
      out.push({
        quantity: parseFloat(m[1]!),
        commodity: normalizeCommodityName(m[2]!),
      });
    }
  }
  return out;
}

/**
 * Parses build material strings like `"20 t Lumber, 30 t Limestone & Granite"`,
 * `"40,000 t Steel, 60,000 t Cement, 5,000 Prefabs"`.
 */
export function parseBuildMaterials(raw: string | undefined): MaterialRequirement[] {
  const text = (raw ?? "").trim();
  if (!text || /^none\b/i.test(text) || /^see\b/i.test(text)) return [];
  // Replace thousands commas inside numbers like "40,000" -> "40000" before splitting
  const normalized = text.replace(/(\d),(\d{3})\b/g, "$1$2");
  const parts = normalized.split(",").map((p) => p.trim()).filter(Boolean);
  const out: MaterialRequirement[] = [];
  for (const part of parts) {
    const m = /^(\d+(?:\.\d+)?)\s*(?:t\s+|modules?\s+|units?\s+)?(.+)$/i.exec(part);
    if (m) {
      out.push({
        quantity: parseFloat(m[1]!),
        commodity: normalizeCommodityName(m[2]!),
      });
    } else {
      const name = normalizeCommodityName(part);
      if (name) out.push({ quantity: 1, commodity: name });
    }
  }
  return out;
}

export interface LandValueModifier {
  percentDelta: number;
  radiusTiles: number;
}

/** Parses `"-20% / 4 tiles"`, `"+25% / 6 tiles"`, `"0.0"`. */
export function parseLandValueEffect(raw: string | undefined): LandValueModifier {
  const text = (raw ?? "").trim();
  const m = /([+-]?\d+(?:\.\d+)?)\s*%[\s\S]*?\/\s*(\d+(?:\.\d+)?)\s*tiles?/i.exec(text);
  if (!m) return { percentDelta: 0, radiusTiles: 0 };
  return {
    percentDelta: parseFloat(m[1]!) / 100,
    radiusTiles: parseFloat(m[2]!),
  };
}
