import React, { useState } from "react";
import { Bus, Layers, TrainFront, Trash2, Wrench, X } from "lucide-react";
import {
  formatMoney,
  type SectorId,
  type TrafficStateDto,
  type WorldSnapshotDto,
} from "@pentapolis/shared-sim";
import type { ActiveToolState } from "../renderer/PeninsulaScene.ts";

interface TransportPanelProps {
  snapshot: WorldSnapshotDto;
  traffic: TrafficStateDto | null;
  activeSectorId: SectorId;
  tool: ActiveToolState;
  undergroundView: boolean;
  onClose: () => void;
  onToggleUnderground: () => void;
  onChangeTool: (tool: ActiveToolState) => void;
  onCreateRoute: (stopIds: readonly string[], fleetSize: number, name: string) => void;
  onDeleteRoute: (routeId: string) => void;
  onSetRoadService: (level: 0 | 1 | 2) => void;
  onRepairAll: () => void;
}

const SERVICE_LEVELS: readonly { level: 0 | 1 | 2; label: string; hint: string }[] = [
  { level: 0, label: "Нет", hint: "0%/мес" },
  { level: 1, label: "Норматив", hint: "+1.5%/мес" },
  { level: 2, label: "Усиленный", hint: "+4.5%/мес" },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Transport Office (Sprint 5): road condition & Road Service budget, licensed bus routes
 * (GDD §5.4: depot + stops, the city sets routes and licenses operators) and the metro layer.
 */
export const TransportPanel: React.FC<TransportPanelProps> = ({
  snapshot,
  traffic,
  activeSectorId,
  tool,
  undergroundView,
  onClose,
  onToggleUnderground,
  onChangeTool,
  onCreateRoute,
  onDeleteRoute,
  onSetRoadService,
  onRepairAll,
}) => {
  const [fleetSize, setFleetSize] = useState(4);
  const [routeName, setRouteName] = useState("");

  const sec = snapshot.sectors.find((s) => s.sectorId === activeSectorId)!;
  const stats = snapshot.transport.find((t) => t.sectorId === activeSectorId);
  const routes = snapshot.busRoutes.filter((r) => r.sectorId === activeSectorId);
  const statusById = new Map((traffic?.busRoutes ?? []).map((r) => [r.routeId, r]));
  const sym = sec.currencySymbol;
  const drawing = tool.mode === "bus_route";

  return (
    <div className="rounded-xl bg-slate-950/95 backdrop-blur-md border border-slate-700 shadow-2xl p-3 text-xs space-y-3">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-1.5 font-bold text-amber-300">
          <Bus className="w-4 h-4" />
          <span>Транспорт S{activeSectorId}</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Закрыть">
          <X className="w-4 h-4" />
        </button>
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
          <span className="text-slate-400">Авто в час</span>
          <span className="font-mono">{stats.carTripsPerHour.toLocaleString("ru-RU")}</span>
          <span className="text-slate-400">Фуры в час</span>
          <span className="font-mono">{stats.truckTripsPerHour}</span>
          <span className="text-slate-400">Пассажиры ОТ в час</span>
          <span className="font-mono">{stats.transitRidersPerHour.toLocaleString("ru-RU")}</span>
          <span className="text-slate-400">Покрытие автобусом</span>
          <span className="font-mono">{pct(stats.busCoverageShare)}</span>
          <span className="text-slate-400">Покрытие метро</span>
          <span className="font-mono">
            {pct(stats.metroCoverageShare)}
            {stats.metroLandValueBoostShare > 0 && <span className="text-emerald-400"> (+25% цена земли)</span>}
          </span>
          <span className="text-slate-400">Средняя прочность дорог</span>
          <span className={`font-mono ${stats.avgRoadHealth < 40 ? "text-rose-400" : stats.avgRoadHealth < 75 ? "text-amber-300" : "text-emerald-300"}`}>
            {stats.avgRoadHealth}%
          </span>
          <span className="text-slate-400">Изношено / пробки</span>
          <span className="font-mono">
            {stats.damagedSegments} / {stats.congestedSegments}
          </span>
        </div>
      )}

      {/* Road Service */}
      <div className="space-y-1.5">
        <div className="text-[11px] text-slate-400">Дорожная служба (восстановление покрытия):</div>
        <div className="grid grid-cols-3 gap-1">
          {SERVICE_LEVELS.map((s) => (
            <button
              key={s.level}
              onClick={() => onSetRoadService(s.level)}
              className={`px-1.5 py-1 rounded border text-[11px] ${stats?.roadServiceLevel === s.level ? "bg-amber-500 border-amber-300 text-slate-950 font-bold" : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}
            >
              {s.label}
              <div className="text-[9px] opacity-70">{s.hint}</div>
            </button>
          ))}
        </div>
        {stats && (
          <div className="text-[10px] text-slate-500">
            Бюджет службы: {sym} {formatMoney(BigInt(stats.roadServiceMonthlyCostMinor))} / мес
          </div>
        )}
        <div className="flex gap-1">
          <button
            onClick={() => onChangeTool(tool.mode === "repair" ? { mode: "inspect" } : { mode: "repair" })}
            className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded border ${tool.mode === "repair" ? "bg-orange-600 border-orange-400 text-white" : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}
          >
            <Wrench className="w-3.5 h-3.5" /> Ремонт участка
          </button>
          <button
            onClick={onRepairAll}
            disabled={!stats || stats.damagedSegments === 0}
            className="flex-1 px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            Все изношенные
          </button>
        </div>
      </div>

      {/* Bus routes */}
      <div className="space-y-1.5">
        <div className="text-[11px] text-slate-400">Автобусные маршруты (лицензии перевозчикам):</div>
        {routes.length === 0 && <div className="text-[11px] text-slate-500">Маршрутов нет.</div>}
        {routes.map((r) => {
          const st = statusById.get(r.id);
          return (
            <div key={r.id} className="px-2 py-1.5 rounded bg-slate-900 border border-slate-800">
              <div className="flex items-center justify-between">
                <span className="font-semibold">
                  {r.name} <span className="text-slate-500 font-normal">· {r.operatorName}</span>
                </span>
                <button onClick={() => onDeleteRoute(r.id)} className="text-slate-500 hover:text-rose-400" title="Отозвать лицензию">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="text-[10px] text-slate-400">
                {r.stopBuildingIds.length} ост. · {r.fleetSize} авт. · сбор {sym} {formatMoney(BigInt(r.licenseFeeMonthlyMinor))}/мес
              </div>
              {st && (
                <div className={`text-[10px] ${st.operating ? "text-emerald-300" : "text-rose-300"}`}>{st.statusRu}</div>
              )}
            </div>
          );
        })}

        {!drawing ? (
          <button
            onClick={() => onChangeTool({ mode: "bus_route", stopIds: [] })}
            className="w-full px-2 py-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 text-white font-semibold"
          >
            + Новый маршрут: выбрать остановки на карте
          </button>
        ) : (
          <div className="space-y-1.5 p-2 rounded-lg border border-sky-600/60 bg-sky-950/40">
            <div className="text-[11px] text-sky-200">
              Кликайте по остановкам TRN-01 по порядку (повторный клик убирает). Выбрано:{" "}
              <b>{tool.stopIds.length}</b>
            </div>
            <input
              value={routeName}
              onChange={(e) => setRouteName(e.target.value)}
              placeholder="Название (например, «Набережная»)"
              className="w-full px-2 py-1 rounded bg-slate-900 border border-slate-700 text-[11px]"
            />
            <label className="flex items-center gap-2 text-[11px]">
              <span className="text-slate-400">Автобусов:</span>
              <input
                type="range"
                min={1}
                max={20}
                value={fleetSize}
                onChange={(e) => setFleetSize(Number(e.target.value))}
                className="flex-1"
              />
              <span className="font-mono w-5 text-right">{fleetSize}</span>
            </label>
            <div className="flex gap-1">
              <button
                disabled={tool.stopIds.length < 2}
                onClick={() => {
                  onCreateRoute(tool.stopIds, fleetSize, routeName);
                  setRouteName("");
                  onChangeTool({ mode: "inspect" });
                }}
                className="flex-1 px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white font-semibold disabled:opacity-40"
              >
                Выдать лицензию
              </button>
              <button
                onClick={() => onChangeTool({ mode: "inspect" })}
                className="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800"
              >
                Отмена
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Metro layer */}
      <div className="space-y-1.5">
        <button
          onClick={onToggleUnderground}
          className={`w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border font-semibold ${undergroundView ? "bg-indigo-600 border-indigo-400 text-white" : "border-indigo-700 text-indigo-200 hover:bg-indigo-950"}`}
        >
          <Layers className="w-3.5 h-3.5" /> {undergroundView ? "Вернуться на поверхность" : "Слой «Под землёй» (метро)"}
        </button>
        {stats && (
          <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
            <TrainFront className="w-3.5 h-3.5 text-indigo-300" />
            {stats.metroStations === 0
              ? "Метро: стройте тоннели TRN-08 и станции TRN-09 (этап S3), нужно метродепо TRN-10"
              : stats.metroOperational
                ? `Метро работает: ${stats.metroStations} ст., −50% поездок на авто у станций`
                : `Станций: ${stats.metroStations}, линия не запущена (нужны метродепо и ≥2 станции на одном тоннеле)`}
          </div>
        )}
      </div>
    </div>
  );
};
