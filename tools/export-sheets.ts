/**
 * Deterministic XLSX -> CSV sheet exporter (GDD §9.3).
 *
 * Reads the canonical balance workbook in `docs/design/*.xlsx`, writes all 25 CSV
 * sheets to `packages/shared-sim/data/sheets/`, and generates
 * `packages/shared-sim/src/catalogs/rawSheets.generated.ts` so both server and
 * browser bundles consume the exact same CSV data without runtime fs shims.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { unzipSync, strFromU8 } from "fflate";

const ROOT = resolve(import.meta.dir, "..");
const DESIGN_DIR = join(ROOT, "docs", "design");
const OUT_CSV_DIR = join(ROOT, "packages", "shared-sim", "data", "sheets");
const OUT_TS_FILE = join(ROOT, "packages", "shared-sim", "src", "catalogs", "rawSheets.generated.ts");

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function colRefToIndex(cellRef: string): number {
  const letters = cellRef.replace(/\d+/g, "");
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

function escapeCsvField(val: string): string {
  if (/[",\r\n]/.test(val)) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRegex.exec(xml)) !== null) {
    const inner = m[1] ?? "";
    const parts: string[] = [];
    const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRegex.exec(inner)) !== null) {
      parts.push(decodeXmlEntities(tm[1] ?? ""));
    }
    out.push(parts.join(""));
  }
  return out;
}

function parseWorksheetToCsv(xml: string, sharedStrings: readonly string[]): string {
  const lines: string[] = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRegex.exec(xml)) !== null) {
    const rowInner = rm[1] ?? "";
    const cells = new Map<number, string>();
    let maxCol = -1;
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRegex.exec(rowInner)) !== null) {
      const attrs = cm[1] ?? "";
      const body = cm[2] ?? "";
      const rMatch = /\br="([A-Z]+\d+)"/.exec(attrs);
      if (!rMatch) continue;
      const col = colRefToIndex(rMatch[1]!);
      if (col > maxCol) maxCol = col;
      const tMatch = /\bt="([^"]+)"/.exec(attrs);
      const cellType = tMatch?.[1] ?? "";
      let val = "";
      if (cellType === "inlineStr") {
        const parts: string[] = [];
        const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let tm: RegExpExecArray | null;
        while ((tm = tRegex.exec(body)) !== null) {
          parts.push(decodeXmlEntities(tm[1] ?? ""));
        }
        val = parts.join("");
      } else {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        if (vMatch) {
          const rawV = decodeXmlEntities(vMatch[1] ?? "");
          if (cellType === "s") {
            val = sharedStrings[parseInt(rawV, 10)] ?? "";
          } else {
            val = rawV;
          }
        }
      }
      cells.set(col, val);
    }
    const rowArr: string[] = [];
    for (let c = 0; c <= maxCol; c++) {
      rowArr.push(escapeCsvField(cells.get(c) ?? ""));
    }
    lines.push(rowArr.join(","));
  }
  return lines.join("\n") + "\n";
}

function main() {
  const xlsxName = readdirSync(DESIGN_DIR).find((f) => f.toLowerCase().endsWith(".xlsx"));
  if (!xlsxName) {
    throw new Error(`No .xlsx workbook found in ${DESIGN_DIR}`);
  }
  const xlsxPath = join(DESIGN_DIR, xlsxName);
  const archive = unzipSync(new Uint8Array(readFileSync(xlsxPath)));

  const readEntry = (p: string): string => {
    const entry = archive[p];
    if (!entry) throw new Error(`Missing zip entry ${p} in ${xlsxName}`);
    return strFromU8(entry);
  };

  const sharedStrings = archive["xl/sharedStrings.xml"]
    ? parseSharedStrings(readEntry("xl/sharedStrings.xml"))
    : [];

  const relsXml = readEntry("xl/_rels/workbook.xml.rels");
  const relMap = new Map<string, string>();
  const relRegex = /<Relationship\b([^>]+?)\/?>/g;
  let relM: RegExpExecArray | null;
  while ((relM = relRegex.exec(relsXml)) !== null) {
    const a = relM[1] ?? "";
    const id = /\bId="([^"]+)"/.exec(a)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(a)?.[1];
    if (id && target) {
      const normalized = target.startsWith("xl/") ? target : `xl/${target.replace(/^\/+/, "")}`;
      relMap.set(id, normalized);
    }
  }

  const wbXml = readEntry("xl/workbook.xml");
  mkdirSync(OUT_CSV_DIR, { recursive: true });

  const sheetEntries: { index: number; name: string; fileName: string; csv: string }[] = [];
  const sheetRegex = /<sheet\b([^>]+?)\/?>/g;
  let sm: RegExpExecArray | null;
  let i = 0;
  while ((sm = sheetRegex.exec(wbXml)) !== null) {
    const a = sm[1] ?? "";
    const name = decodeXmlEntities(/\bname="([^"]+)"/.exec(a)?.[1] ?? "");
    const rId = /\br:id="([^"]+)"/.exec(a)?.[1] ?? "";
    const target = relMap.get(rId);
    if (!name || !target) continue;
    i++;
    const csv = parseWorksheetToCsv(readEntry(target), sharedStrings);
    const safeName = name.replace(/[^A-Za-z0-9 &_-]/g, "_");
    const fileName = `${String(i).padStart(2, "0")}_${safeName}.csv`;
    writeFileSync(join(OUT_CSV_DIR, fileName), csv, "utf8");
    sheetEntries.push({ index: i, name, fileName, csv });
  }

  const tsLines: string[] = [
    "// AUTO-GENERATED by tools/export-sheets.ts — DO NOT EDIT MANUALLY.",
    "// Edit the canonical .xlsx table in docs/design/ and run `bun run export-sheets`.",
    "",
    "export const RAW_SHEETS: Readonly<Record<string, string>> = {",
  ];
  for (const s of sheetEntries) {
    tsLines.push(`  ${JSON.stringify(s.name)}: ${JSON.stringify(s.csv)},`);
  }
  tsLines.push("};", "");
  tsLines.push(
    "export const SHEET_FILE_MAP: Readonly<Record<string, string>> = {",
    ...sheetEntries.map((s) => `  ${JSON.stringify(s.name)}: ${JSON.stringify(s.fileName)},`),
    "};",
    ""
  );
  mkdirSync(dirname(OUT_TS_FILE), { recursive: true });
  writeFileSync(OUT_TS_FILE, tsLines.join("\n"), "utf8");
  console.log(`Exported ${sheetEntries.length} sheets from "${xlsxName}" to ${OUT_CSV_DIR}`);
}

main();
