import React, { useState } from "react";
import { ChevronDown, ChevronUp, Construction } from "lucide-react";
import { formatMoney, type SectorId, type WorldSnapshotDto } from "@pentapolis/shared-sim";

interface ConstructionMarketCardProps {
  snapshot: WorldSnapshotDto;
  activeSectorId: SectorId;
}

/** Plant that supplies each material locally (GDD §4.1). */
const LOCAL_SOURCE_RU: Readonly<Record<string, string>> = {
  Lumber: "Лесопилка PRO-06",
  "Limestone & Granite": "Каменный карьер EXT-04",
  Cement: "Цементный завод PRO-04",
  Steel: "Сталелитейный комбинат PRO-01",
  "Construction Prefabs": "Завод префабов CMP-04",
};

const tph = (v: number) => `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} т/ч`;

/**
 * Developer construction market (Sprint 4, GDD §6.1): what the zones need per hour, what local
 * plants and the starter gateway supply, and which material stalls the cranes.
 */
export const ConstructionMarketCard: React.FC<ConstructionMarketCardProps> = ({ snapshot, activeSectorId }) => {
  const [open, setOpen] = useState(true);
  const stats = snapshot.construction.find((c) => c.sectorId === activeSectorId);
  const sym = snapshot.sectors.find((s) => s.sectorId === activeSectorId)?.currencySymbol ?? "";
  if (!stats || (stats.activeSites === 0 && stats.stalledSites === 0)) return null;

  const rows = stats.materials.filter((m) => m.demandTonsPerHour > 0 || m.localCapacityTonsPerHour > 0);
  const short = rows.filter((m) => m.shortfallTonsPerHour > 0.01);
  const fillPct = Math.round(stats.fillRatio * 100);

  return (
    <div className="rounded-lg bg-slate-950/90 backdrop-blur-md border border-slate-800 p-2.5 text-xs shadow-xl">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between font-bold text-amber-300">
        <span className="flex items-center gap-1.5">
          <Construction className="w-3.5 h-3.5" /> Стройка девелоперов S{activeSectorId}
        </span>
        <span className="flex items-center gap-1 text-[10px] font-normal text-slate-400">
          <span className={fillPct >= 90 ? "text-emerald-300" : fillPct >= 40 ? "text-amber-300" : "text-rose-400"}>
            {fillPct}%
          </span>
          {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </span>
      </button>

      {open && (
        <div className="mt-1.5 space-y-1.5">
          <div className="text-[10px] text-slate-400">
            Стройплощадок: {stats.activeSites} · без материалов: {stats.stalledSites} ·{" "}
            {stats.gatewayImportOpen ? `импорт через шлюз до ${stats.importCapTonsPerHour} т/ч` : "шлюз не соединён дорогой"}
          </div>
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-slate-500">
                <th className="text-left font-normal">Материал</th>
                <th className="text-right font-normal">Нужно</th>
                <th className="text-right font-normal">Свои</th>
                <th className="text-right font-normal">Импорт</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.material} className={m.shortfallTonsPerHour > 0.01 ? "text-rose-300" : "text-slate-300"}>
                  <td>{m.nameRu}</td>
                  <td className="text-right font-mono">{tph(m.demandTonsPerHour)}</td>
                  <td className="text-right font-mono">{tph(m.localTonsPerHour)}</td>
                  <td className="text-right font-mono" title={`${sym} ${formatMoney(BigInt(m.importPricePerTonMinor))}/т с фрахтом и пошлиной`}>
                    {tph(m.importedTonsPerHour)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {short.length > 0 && (
            <div className="text-[10px] text-rose-300">
              Не хватает: {short.map((m) => `${m.nameRu} (${LOCAL_SOURCE_RU[m.material] ?? "импорт"})`).join(", ")}
              {!stats.gatewayImportOpen && " — или протяните дорогу к шлюзу"}
            </div>
          )}
          {stats.importDutyMinor !== "0" && (
            <div className="text-[10px] text-slate-500">
              Ввозная пошлина в казну за последний шаг: {sym} {formatMoney(BigInt(stats.importDutyMinor))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
