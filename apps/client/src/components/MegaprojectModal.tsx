import React, { useState } from "react";
import { Atom, Coins, Compass, PackageCheck, Rocket, Sparkles, Truck, X } from "lucide-react";
import {
  MEGAPROJECT_RESOURCE_NAMES_RU,
  MEGAPROJECT_SPECS,
  formatMoney,
  type ClientCommand,
  type MegaprojectCatalogId,
  type MegaprojectResourceId,
  type SectorId,
  type WorldSnapshotDto,
} from "@pentapolis/shared-sim";

interface MegaprojectModalProps {
  snapshot: WorldSnapshotDto;
  activeSectorId: SectorId;
  onSendCommand: (cmd: ClientCommand) => void;
  onFocusCore: () => void;
  onClose: () => void;
}

const MEGA_IDS: readonly MegaprojectCatalogId[] = ["MEG-01", "MEG-02", "MEG-03", "MEG-04"];
const RESOURCES: readonly MegaprojectResourceId[] = ["Steel", "Cement", "Microchips", "Industrial Machinery"];
const SECTOR_COLORS: Readonly<Record<SectorId, string>> = {
  1: "bg-amber-500",
  2: "bg-emerald-500",
  3: "bg-sky-500",
  4: "bg-purple-500",
  5: "bg-rose-500",
};

const STATUS_BADGE = {
  funding: { label: "Сбор караванов и МРЕ", cls: "bg-amber-950 border-amber-600 text-amber-200" },
  building: { label: "Идёт возведение", cls: "bg-sky-950 border-sky-500 text-sky-200" },
  operational: { label: "Введён в эксплуатацию", cls: "bg-emerald-950 border-emerald-500 text-emerald-200" },
} as const;

export const MegaprojectModal: React.FC<MegaprojectModalProps> = ({
  snapshot,
  activeSectorId,
  onSendCommand,
  onFocusCore,
  onClose,
}) => {
  const [source, setSource] = useState<"treasury" | "swf">("treasury");
  const [trancheWcu, setTrancheWcu] = useState<number>(25_000_000);
  const [caravanResource, setCaravanResource] = useState<MegaprojectResourceId>("Steel");
  const [caravanTons, setCaravanTons] = useState<number>(2_000);

  const activeSec = snapshot.sectors.find((s) => s.sectorId === activeSectorId) ?? snapshot.sectors[0]!;
  const foundedByCatalog = new Map(snapshot.megaprojects.map((m) => [m.catalogId, m]));

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm p-2 sm:p-4">
      <div className="compact-modal w-full max-w-5xl max-h-[92vh] overflow-y-auto rounded-2xl bg-slate-950 border border-violet-600/60 shadow-2xl text-xs text-slate-100 flex flex-col">
        {/* Sticky Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-4 py-2.5 bg-slate-950/95 border-b border-slate-800">
          <div className="flex items-center gap-2 font-bold text-sm text-violet-300">
            <Atom className="w-4 h-4 text-violet-400" />
            <span>Кооперативные Мегапроекты Центрального Ядра (500, 500 · R=60)</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                onFocusCore();
                onClose();
              }}
              className="min-h-[36px] px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 flex items-center gap-1"
            >
              <Compass className="w-3.5 h-3.5" />
              <span>Камера на Ядро</span>
            </button>
            <button
              onClick={onClose}
              className="min-h-[36px] px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white flex items-center gap-1"
            >
              <X className="w-4 h-4" />
              <span>Закрыть</span>
            </button>
          </div>
        </div>

        <div className="p-4 space-y-3">
          {/* Contribution Toolbar */}
          <div className="rounded-xl bg-slate-900/90 border border-slate-800 p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-slate-400">Источник оплаты S{activeSectorId}:</span>
              <button
                onClick={() => setSource("treasury")}
                className={`min-h-[38px] px-3 py-1 rounded-lg border font-medium ${
                  source === "treasury"
                    ? "bg-violet-700 border-violet-400 text-white"
                    : "bg-slate-950 border-slate-700 text-slate-300"
                }`}
              >
                Казна ({activeSec.currencySymbol} {formatMoney(BigInt(activeSec.treasuryBalanceMinor))})
              </button>
              <button
                onClick={() => setSource("swf")}
                className={`min-h-[38px] px-3 py-1 rounded-lg border font-medium ${
                  source === "swf"
                    ? "bg-violet-700 border-violet-400 text-white"
                    : "bg-slate-950 border-slate-700 text-slate-300"
                }`}
              >
                Суверенный Фонд ({formatMoney(BigInt(activeSec.swfBalanceWcuMinor))} МРЕ)
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5">
                <span className="text-slate-400">Караван:</span>
                <select
                  value={caravanResource}
                  onChange={(e) => setCaravanResource(e.target.value as MegaprojectResourceId)}
                  className="min-h-[36px] px-2 py-1 rounded bg-slate-950 border border-slate-700 text-slate-100"
                >
                  {RESOURCES.map((r) => (
                    <option key={r} value={r}>
                      {MEGAPROJECT_RESOURCE_NAMES_RU[r]}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={100}
                  max={50_000}
                  step={500}
                  value={caravanTons}
                  onChange={(e) => setCaravanTons(Math.max(100, Number(e.target.value)))}
                  className="w-20 min-h-[36px] px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-right"
                />
                <span className="text-slate-400">т</span>
              </label>

              <label className="flex items-center gap-1.5">
                <span className="text-slate-400">Транш МРЕ:</span>
                <input
                  type="number"
                  min={1_000_000}
                  step={5_000_000}
                  value={trancheWcu}
                  onChange={(e) => setTrancheWcu(Math.max(100_000, Number(e.target.value)))}
                  className="w-28 min-h-[36px] px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-right"
                />
              </label>
            </div>
          </div>

          {/* 4 Megaproject Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {MEGA_IDS.map((catId) => {
              const spec = MEGAPROJECT_SPECS[catId];
              const m = foundedByCatalog.get(catId);
              const costMinor = BigInt(m?.costWcuMinor ?? spec.costWcuMinor.toString());
              const fundedMinor = BigInt(m?.fundedWcuMinor ?? "0");
              const fundedPct = costMinor > 0n ? Math.min(100, Number((fundedMinor * 1000n) / costMinor) / 10) : 0;
              const myStake = m?.stakes.find((s) => s.sectorId === activeSectorId);

              return (
                <div
                  key={catId}
                  className="rounded-xl bg-slate-900/85 border border-slate-800 p-3.5 flex flex-col justify-between space-y-3"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-[10px] font-mono text-violet-400">{catId}</div>
                        <div className="font-bold text-sm text-white flex items-center gap-1.5">
                          <Rocket className="w-4 h-4 text-violet-400 shrink-0" />
                          <span>{spec.nameRu}</span>
                        </div>
                      </div>
                      {m ? (
                        <span className={`px-2 py-0.5 rounded border text-[10px] font-semibold ${STATUS_BADGE[m.status].cls}`}>
                          {STATUS_BADGE[m.status].label}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded border border-slate-700 bg-slate-950 text-slate-400 text-[10px]">
                          Площадка свободна
                        </span>
                      )}
                    </div>

                    <div className="rounded-lg bg-violet-950/30 border border-violet-800/40 px-2.5 py-1.5 text-[11px] text-violet-200 flex items-start gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                      <span>{m?.bonusSummaryRu ?? spec.bonusSummaryRu}</span>
                    </div>

                    {/* WCU Funding Progress */}
                    <div>
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="text-slate-400">Финансирование и поставки:</span>
                        <span className="font-mono text-slate-200">
                          {formatMoney(fundedMinor)} / {formatMoney(costMinor)} МРЕ ({fundedPct.toFixed(1)}%)
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-950 overflow-hidden border border-slate-800">
                        <div className="h-full bg-violet-500 transition-all" style={{ width: `${fundedPct}%` }} />
                      </div>
                      {m?.status === "building" && (
                        <div className="mt-1.5">
                          <div className="flex justify-between text-[10px] text-sky-300 mb-0.5">
                            <span>Готовность конструкции в Центральном Ядре</span>
                            <span className="font-mono">{Math.round(m.constructionProgress * 100)}%</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-slate-950 overflow-hidden">
                            <div
                              className="h-full bg-sky-400"
                              style={{ width: `${Math.round(m.constructionProgress * 100)}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 4 Resource Progress Bars */}
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      {RESOURCES.map((resId) => {
                        const req = m?.requiredResources?.[resId] ?? spec.requiredResources[resId];
                        const deliv = m?.deliveredResources?.[resId] ?? 0;
                        const pct = req > 0 ? Math.min(100, Math.round((deliv / req) * 100)) : 100;
                        return (
                          <div key={resId} className="rounded bg-slate-950/80 border border-slate-800/90 p-1.5">
                            <div className="flex justify-between text-[10px]">
                              <span className="text-slate-300 flex items-center gap-1">
                                <PackageCheck className="w-3 h-3 text-emerald-400" />
                                {MEGAPROJECT_RESOURCE_NAMES_RU[resId]}
                              </span>
                              <span className="font-mono text-slate-400">
                                {deliv.toLocaleString("ru-RU")}/{req.toLocaleString("ru-RU")} т
                              </span>
                            </div>
                            <div className="h-1.5 rounded bg-slate-800 overflow-hidden mt-1">
                              <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* 5-Sector Equity Share Bar */}
                    {m && (
                      <div className="space-y-1 pt-1">
                        <div className="h-2 rounded-full bg-slate-950 overflow-hidden flex">
                          {m.stakes.map((st) => (
                            <div
                              key={st.sectorId}
                              className={`${SECTOR_COLORS[st.sectorId]} h-full`}
                              style={{ width: `${Math.max(1, st.share * 100)}%` }}
                              title={`Сектор S${st.sectorId}: ${(st.share * 100).toFixed(1)}%`}
                            />
                          ))}
                        </div>
                        <div className="text-[10px] text-slate-400 flex flex-wrap justify-between gap-1">
                          <span>
                            Доли:{" "}
                            {m.stakes.length > 0
                              ? m.stakes.map((st) => `S${st.sectorId} ${(st.share * 100).toFixed(1)}%`).join(" · ")
                              : "взносов пока нет"}
                          </span>
                          {myStake && (
                            <span className="text-violet-300 font-semibold">
                              Ваша доля S{activeSectorId}: {(myStake.share * 100).toFixed(1)}%
                            </span>
                          )}
                        </div>
                        {m.status === "operational" && (
                          <div className="text-[11px] text-emerald-300 font-mono">
                            Дивиденды пула: {formatMoney(BigInt(m.monthlyDividendWcuMinor))} МРЕ/мес
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Action Buttons */}
                  {!m ? (
                    <button
                      onClick={() =>
                        onSendCommand({
                          type: "found_megaproject",
                          sectorId: activeSectorId,
                          catalogId: catId,
                        })
                      }
                      className="w-full min-h-[40px] px-3 py-2 rounded-lg bg-violet-700 hover:bg-violet-600 text-white font-bold transition"
                    >
                      Заложить «{spec.nameRu}» в Центральном Ядре
                    </button>
                  ) : m.status === "funding" ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                      <button
                        onClick={() =>
                          onSendCommand({
                            type: "contribute_megaproject",
                            sectorId: activeSectorId,
                            buildingId: m.buildingId,
                            amountUnits: 0,
                            source,
                            caravanCommodity: caravanResource,
                            caravanTons,
                          })
                        }
                        className="min-h-[40px] px-2.5 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-semibold flex items-center justify-center gap-1.5"
                      >
                        <Truck className="w-3.5 h-3.5 shrink-0" />
                        <span>Отправить караван стройматериалов</span>
                      </button>
                      <button
                        onClick={() =>
                          onSendCommand({
                            type: "contribute_megaproject",
                            sectorId: activeSectorId,
                            buildingId: m.buildingId,
                            amountUnits: trancheWcu,
                            source,
                          })
                        }
                        className="min-h-[40px] px-2.5 py-1.5 rounded-lg bg-violet-700 hover:bg-violet-600 text-white font-semibold flex items-center justify-center gap-1.5"
                      >
                        <Coins className="w-3.5 h-3.5 shrink-0" />
                        <span>Перевести транш WCU</span>
                      </button>
                    </div>
                  ) : (
                    <div className="text-[11px] text-center py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-300">
                      {m.status === "building"
                        ? "Строители Центрального Ядра возводят объект — бонусы включатся на 100%"
                        : "✅ Мегапроект активен и ежемесячно начисляет дивиденды и очки Гегемонии"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
