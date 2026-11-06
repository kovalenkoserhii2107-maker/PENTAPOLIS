import React, { useState } from "react";
import { AlertTriangle, Car, Landmark, Map as MapIcon, Siren, Users, X } from "lucide-react";
import {
  CANONICAL_DECREES,
  CANONICAL_EMERGENCIES,
  type ClientCommand,
  type SectorId,
  type WorldSnapshotDto,
} from "@pentapolis/shared-sim";

interface CityPanelProps {
  snapshot: WorldSnapshotDto;
  activeSectorId: SectorId;
  landValueOverlay: boolean;
  onToggleLandValueOverlay: () => void;
  onFocusTile: (tileX: number, tileY: number) => void;
  onSendCommand: (cmd: ClientCommand) => void;
  onClose: () => void;
}

type Tab = "districts" | "emergencies" | "decrees" | "autos" | "advisors";

const TABS: readonly { id: Tab; label: string; icon: React.FC<{ className?: string }> }[] = [
  { id: "advisors", label: "Советники", icon: Users },
  { id: "districts", label: "Районы", icon: MapIcon },
  { id: "emergencies", label: "ЧП", icon: Siren },
  { id: "decrees", label: "Указы", icon: Landmark },
  { id: "autos", label: "Авто", icon: Car },
];

const TIER_SWATCH = ["bg-orange-800", "bg-amber-600", "bg-lime-600", "bg-cyan-600", "bg-yellow-400"];
const TIER_NAMES = ["Окраины", "Рабочий", "Средний", "Престижный", "Элита"];
const STAGE_NAMES = ["Новые", "Trade-In", "Б/у", "Старые (СТО)", "Лом"];
const SEVERITY_STYLE = {
  critical: "border-rose-500/70 bg-rose-950/60 text-rose-100",
  warning: "border-amber-500/60 bg-amber-950/40 text-amber-100",
  info: "border-slate-700 bg-slate-900 text-slate-200",
} as const;

const pct = (v: number) => `${Math.round(v * 100)}%`;

function CoverageBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-28 text-slate-400">{label}</span>
      <div className="flex-1 h-1.5 rounded bg-slate-800 overflow-hidden">
        <div
          className={`h-full ${value >= 0.8 ? "bg-emerald-400" : value >= 0.4 ? "bg-amber-400" : "bg-rose-500"}`}
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </div>
      <span className="w-9 text-right font-mono">{pct(value)}</span>
    </div>
  );
}

/**
 * City Hall (Sprint 6): district stratification & services, live emergencies with dispatched
 * crews, the 8 decrees, the car lifecycle market and the 3 advisors.
 */
export const CityPanel: React.FC<CityPanelProps> = ({
  snapshot,
  activeSectorId,
  landValueOverlay,
  onToggleLandValueOverlay,
  onFocusTile,
  onSendCommand,
  onClose,
}) => {
  const [tab, setTab] = useState<Tab>("advisors");
  const sec = snapshot.sectors.find((s) => s.sectorId === activeSectorId)!;
  const city = snapshot.city.find((c) => c.sectorId === activeSectorId);
  const autos = snapshot.autos.find((a) => a.sectorId === activeSectorId);
  const advisors = snapshot.advisors.find((a) => a.sectorId === activeSectorId)?.advisors ?? [];
  const districts = snapshot.districts.filter((d) => d.sectorId === activeSectorId);
  const emergencies = snapshot.emergencies.filter((e) => e.sectorId === activeSectorId);
  const zonesById = new Map(snapshot.zones.map((z) => [z.id, z]));
  const totalTier = city ? city.residentsByTier.reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="compact-modal rounded-xl bg-slate-950/95 backdrop-blur-md border border-slate-700 shadow-2xl p-3 text-xs space-y-2.5">
      <div className="compact-modal-header flex items-center justify-between bg-slate-950/95 border-b border-slate-800 pb-2">
        <div className="flex items-center gap-1.5 font-bold text-emerald-300">
          <Landmark className="w-4 h-4" />
          <span>Мэрия S{activeSectorId}: город</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Закрыть">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 flex flex-col items-center gap-0.5 px-1 py-1 rounded text-[10px] ${tab === t.id ? "bg-emerald-700 text-white" : "text-slate-400 hover:bg-slate-800"}`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
            {t.id === "emergencies" && emergencies.length > 0 && (
              <span className="px-1 rounded bg-rose-600 text-white text-[9px]">{emergencies.length}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "advisors" && (
        <div className="space-y-2">
          {advisors.map((a) => (
            <div key={a.advisorId}>
              <div className="text-[11px] font-semibold text-slate-300 mb-1">{a.nameRu}</div>
              <ul className="space-y-1">
                {a.tips.map((t) => (
                  <li key={t.text} className={`px-2 py-1 rounded border text-[11px] ${SEVERITY_STYLE[t.severity]}`}>
                    <div className="flex items-start gap-1">
                      {t.severity === "critical" && <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />}
                      <span>{t.text}</span>
                    </div>
                    {t.hint && <div className="text-[10px] opacity-70 mt-0.5">→ {t.hint}</div>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {tab === "districts" && (
        <div className="space-y-2">
          {!city || city.districts === 0 ? (
            <div className="text-slate-500 text-[11px]">Разметьте зоны — районы появятся по мере застройки.</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
                <span className="text-slate-400">Жителей в районах</span>
                <span className="font-mono">{city.residents.toLocaleString("ru-RU")}</span>
                <span className="text-slate-400">Цена земли (средн.)</span>
                <span className="font-mono">${city.avgLandValuePerTile.toLocaleString("ru-RU")}/тайл</span>
                <span className="text-slate-400">Преступность</span>
                <span className="font-mono">{pct(city.avgCrimeRate)}</span>
                <span className="text-slate-400">Экология</span>
                <span className="font-mono">{pct(city.avgEcology)}</span>
                <span className="text-slate-400">Счастье районов</span>
                <span className="font-mono">{city.districtHappiness}</span>
              </div>
              {totalTier > 0 && (
                <div>
                  <div className="flex h-2.5 rounded overflow-hidden" title="Жители по уровням районов">
                    {city.residentsByTier.map((n, i) => (
                      <div key={i} className={TIER_SWATCH[i]} style={{ width: `${(n / totalTier) * 100}%` }} />
                    ))}
                  </div>
                  <div className="flex justify-between text-[9px] text-slate-500 mt-0.5">
                    {TIER_NAMES.map((n) => <span key={n}>{n}</span>)}
                  </div>
                </div>
              )}
              <div className="space-y-1">
                <CoverageBar label="Полиция" value={city.coverage.police} />
                <CoverageBar label="Пожарные" value={city.coverage.fire} />
                <CoverageBar label="Медицина" value={city.coverage.health} />
                <CoverageBar label="Парки" value={city.coverage.park} />
                <CoverageBar label="Детсады" value={city.coverage.kindergarten} />
                <CoverageBar label="Школы" value={city.coverage.school} />
                <CoverageBar label="Колледж / вуз" value={city.coverage.higherEducation} />
              </div>
              <ul className="space-y-0.5 max-h-36 overflow-y-auto">
                {districts.map((d) => {
                  const z = zonesById.get(d.zoneId);
                  const canUpgrade =
                    d.zoneKind === "RES-01" ||
                    d.zoneKind === "RES-02" ||
                    d.zoneKind === "COM-01" ||
                    d.zoneKind === "COM-02" ||
                    d.zoneKind === "OFF-01";
                  return (
                    <li key={d.zoneId} className="flex items-center gap-1">
                      <button
                        onClick={() => z && onFocusTile(z.x + z.width / 2, z.y + z.depth / 2)}
                        className="flex-1 flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-slate-800 text-[10px] text-left min-w-0"
                      >
                        <span className={`w-2 h-2 rounded-sm shrink-0 ${TIER_SWATCH[d.tier - 1]}`} />
                        <span className="flex-1 truncate">
                          {d.zoneKind} [{d.visualClass}] #{d.zoneId} · {d.tierNameRu}
                        </span>
                        <span className="font-mono shrink-0">${d.landValuePerTile}</span>
                      </button>
                      {canUpgrade && (
                        <button
                          onClick={() =>
                            onSendCommand({ type: "upgrade_zone", sectorId: activeSectorId, zoneId: d.zoneId })
                          }
                          className="px-1.5 py-0.5 rounded bg-sky-700/80 hover:bg-sky-600 text-white text-[9px] shrink-0"
                          title="Редевелопмент: повысить плотность квартала (потребуется цемент, сталь, префабы)"
                        >
                          ↑ Плотн.
                        </button>
                      )}
                      <button
                        onClick={() =>
                          onSendCommand({ type: "demolish_zone", sectorId: activeSectorId, zoneId: d.zoneId })
                        }
                        className="px-1.5 py-0.5 rounded bg-rose-800/80 hover:bg-rose-700 text-rose-100 text-[9px] shrink-0"
                        title="Снос со 100% выкупом жилья и земли у собственников (Eminent Domain)"
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <button
            onClick={onToggleLandValueOverlay}
            className={`w-full px-2 py-1 rounded border ${landValueOverlay ? "bg-amber-500 border-amber-300 text-slate-950 font-bold" : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}
          >
            {landValueOverlay ? "Скрыть карту цены земли" : "Карта цены земли на зонах"}
          </button>
        </div>
      )}

      {tab === "emergencies" && (
        <div className="space-y-1.5">
          {emergencies.length === 0 && <div className="text-[11px] text-slate-500">ЧП нет. Службы на дежурстве.</div>}
          {emergencies.map((e) => (
            <button
              key={e.instanceId}
              onClick={() => onFocusTile(e.tileX, e.tileY)}
              className={`w-full text-left px-2 py-1.5 rounded border ${e.attended === false ? "border-rose-500/70 bg-rose-950/50" : "border-orange-500/50 bg-orange-950/30"}`}
            >
              <div className="font-semibold text-[11px]">🚨 {e.titleRu.split(":")[0]}</div>
              {e.causeRu && <div className="text-[10px] text-slate-400">Причина: {e.causeRu}</div>}
              {e.statusRu && <div className="text-[10px] text-slate-200">{e.statusRu}</div>}
            </button>
          ))}
          <div className="text-[10px] text-slate-500 pt-1 border-t border-slate-800">
            Ответственные службы:{" "}
            {CANONICAL_EMERGENCIES.filter((e) => e.responderBuildingId && e.id !== "FROZEN_CONSTRUCTION")
              .map((e) => `${e.nameRu.split(" ")[0]} → ${e.responderBuildingId}`)
              .join(" · ")}
          </div>
        </div>
      )}

      {tab === "decrees" && (
        <div className="space-y-1 max-h-80 overflow-y-auto pr-1">
          {CANONICAL_DECREES.map((dec) => {
            const active = sec.activeDecreeIds.includes(dec.id);
            return (
              <button
                key={dec.id}
                onClick={() => onSendCommand({ type: "update_policy", sectorId: activeSectorId, toggleDecreeId: dec.id })}
                className={`w-full text-left p-2 rounded border transition ${active ? "bg-emerald-950/50 border-emerald-500" : "bg-slate-900 hover:bg-slate-800 border-slate-800"}`}
              >
                <div className="flex items-center justify-between font-semibold text-[11px]">
                  <span>{dec.nameRu}</span>
                  <span className={`px-1.5 rounded text-[9px] ${active ? "bg-emerald-600 text-white" : "bg-slate-800 text-slate-400"}`}>
                    {active ? "ВКЛ" : "ВЫКЛ"}
                  </span>
                </div>
                <div className="text-[10px] text-emerald-300">+ {dec.effectSummary}</div>
                <div className="text-[10px] text-slate-500">− {dec.sideEffectSummary}</div>
              </button>
            );
          })}
        </div>
      )}

      {tab === "autos" && (
        <div className="space-y-2">
          {!autos || autos.targetFleet === 0 ? (
            <div className="text-[11px] text-slate-500">Машины появятся, когда в районах поселятся семьи.</div>
          ) : (
            <>
              <div className="grid grid-cols-5 gap-1 text-center">
                {autos.fleetByStage.map((n, i) => (
                  <div key={i} className="rounded bg-slate-900 px-1 py-1">
                    <div className="font-mono text-[12px]">{n.toLocaleString("ru-RU")}</div>
                    <div className="text-[9px] text-slate-500">{STAGE_NAMES[i]}</div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
                <span className="text-slate-400">Новых в месяц</span>
                <span className="font-mono">
                  {autos.newCarsPerMonth} {autos.newCarsImported ? "(импорт, +30%)" : "(свой автосалон)"}
                </span>
                <span className="text-slate-400">Поломок в месяц</span>
                <span className="font-mono">{autos.breakdownsPerMonth}</span>
                <span className="text-slate-400">Отремонтировано СТО</span>
                <span className={`font-mono ${autos.strandedPerMonth > 0 ? "text-amber-300" : ""}`}>
                  {autos.repairedPerMonth} ({autos.repairShops} СТО)
                </span>
                <span className="text-slate-400">Металлолом</span>
                <span className="font-mono">
                  {autos.scrapTonsPerMonth} т/мес, переработано {autos.scrapRecycledTonsPerMonth} т
                </span>
              </div>
              <div className="text-[10px] text-slate-500">
                Цепочка: автосалон {autos.dealership ? "✓" : "✗"} → trade-in {autos.usedLot ? "✓" : "✗"} → СТО {autos.repairShops > 0 ? "✓" : "✗"} → авторазборка{" "}
                {autos.scrapyards > 0 ? "✓" : "✗"}. Ямы на дорогах учащают поломки.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
