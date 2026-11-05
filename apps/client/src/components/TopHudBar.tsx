import React from "react";
import {
  BarChart3,
  CheckCircle2,
  Compass,
  Landmark,
  MessageSquare,
  ShieldAlert,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";
import { formatMoney, type SectorId, type WorldSnapshotDto } from "@pentapolis/shared-sim";

interface TopHudBarProps {
  snapshot: WorldSnapshotDto;
  activeSectorId: SectorId;
  onOpenRegionModal: () => void;
  onOpenMacroModal: () => void;
  onToggleChat: () => void;
  onToggleAdmin: () => void;
  onFocusSector: (s: SectorId | "core") => void;
  onFocusOverview: () => void;
}

export const TopHudBar: React.FC<TopHudBarProps> = ({
  snapshot,
  activeSectorId,
  onOpenRegionModal,
  onOpenMacroModal,
  onToggleChat,
  onToggleAdmin,
  onFocusSector,
  onFocusOverview,
}) => {
  const sec = snapshot.sectors.find((s) => s.sectorId === activeSectorId) ?? snapshot.sectors[0]!;
  const treasuryFormatted = formatMoney(BigInt(sec.treasuryBalanceMinor));
  const cal = snapshot.calendar;

  return (
    <header className="pointer-events-auto flex items-center justify-between gap-2 px-3 py-1.5 bg-slate-950/90 backdrop-blur-md border-b border-slate-800 text-xs shadow-lg">
      {/* Left: Active Sector + Treasury + FX */}
      <div className="flex items-center gap-2">
        <button
          onClick={onOpenRegionModal}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-200 font-semibold transition"
          title="Выбрать или возглавить сектор"
        >
          <Landmark className="w-3.5 h-3.5 text-amber-400" />
          <span>S{sec.sectorId}: {sec.cityName}</span>
          <span className="px-1.5 py-0.5 rounded bg-amber-400/20 text-[10px] text-amber-300">
            {sec.stage}
          </span>
        </button>

        <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
          <span className="text-emerald-400 font-bold">
            {sec.currencySymbol} {treasuryFormatted}
          </span>
          <span className="text-slate-400">|</span>
          <span className="text-sky-300" title="Плавающий курс к Мировой расчётной единице (МРЕ)">
            {sec.fxRatePerWcu.toFixed(3)} {sec.currencySymbol}/МРЕ
          </span>
          <span className="text-slate-400">|</span>
          <span
            className={
              sec.annualInflation > 0.08 ? "text-rose-400 font-medium" : "text-slate-300"
            }
          >
            Инфл. {(sec.annualInflation * 100).toFixed(1)}%
          </span>
        </div>

        {/* Population, Happiness, Power */}
        <div className="hidden xl:flex items-center gap-3 px-2.5 py-1 rounded bg-slate-900/80 border border-slate-800 text-slate-200">
          <span className="flex items-center gap-1" title="Домохозяйства / Жители">
            <Users className="w-3.5 h-3.5 text-sky-400" />
            {sec.households.toLocaleString("ru-RU")} сем.
          </span>
          <span className="flex items-center gap-1" title="Индекс счастья горожан (0..100)">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            H {sec.happinessIndex.toFixed(0)}
          </span>
          <span
            className={`flex items-center gap-1 ${
              sec.powerDemandMw > sec.powerSupplyMw ? "text-rose-400 font-bold" : "text-emerald-300"
            }`}
            title="Баланс электроэнергии сектора (Выработка / Спрос МВт)"
          >
            <Zap className="w-3.5 h-3.5" />
            {sec.powerSupplyMw}/{sec.powerDemandMw} МВт
          </span>
        </div>
      </div>

      {/* Center: Quick Camera Jump S1..S5 + Core + Overview */}
      <div className="hidden lg:flex items-center gap-1 bg-slate-900/90 px-1.5 py-0.5 rounded border border-slate-800">
        {([1, 2, 3, 4, 5] as const).map((sId) => (
          <button
            key={sId}
            onClick={() => onFocusSector(sId)}
            className={`px-1.5 py-0.5 rounded text-[11px] font-medium transition ${
              sId === activeSectorId
                ? "bg-sky-600 text-white"
                : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            }`}
            title={`Камера на Сектор ${sId}`}
          >
            S{sId}
          </button>
        ))}
        <button
          onClick={() => onFocusSector("core")}
          className="px-1.5 py-0.5 rounded text-[11px] text-amber-300 hover:bg-slate-800"
          title="Центральное Ядро Мегапроектов (500, 500)"
        >
          Ядро
        </button>
        <button
          onClick={onFocusOverview}
          className="p-1 rounded text-slate-300 hover:bg-slate-800"
          title="Обзор всего полуострова"
        >
          <Compass className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Right: Dual Calendar + Double-Entry Audit Badge + Action Buttons */}
      <div className="flex items-center gap-2">
        <div
          className={`flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-mono ${
            snapshot.invariantAllZero
              ? "bg-emerald-950/70 border-emerald-600/50 text-emerald-300"
              : "bg-rose-950/80 border-rose-500 text-rose-200"
          }`}
          title="Инвариант двойной записи BigInt по 7 колонкам (0.00 расхождений)"
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>{snapshot.invariantAllZero ? "0.00 diff" : "ERR"}</span>
        </div>

        <div
          className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800 font-mono text-[11px] text-slate-200"
          title={`Жизнь горожан: ${cal.citizenLifeYearsElapsed.toFixed(1)} лет (Сезон: день ${snapshot.seasonDay}/30)`}
        >
          Г{cal.economicYear} · М{String(cal.economicMonth).padStart(2, "0")} · Д
          {String(cal.economicDayOfMonth).padStart(2, "0")}{" "}
          {String(cal.economicHourOfDay).padStart(2, "0")}:
          {String(cal.economicMinuteOfHour).padStart(2, "0")}
        </div>

        <button
          onClick={onOpenMacroModal}
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium transition"
        >
          <BarChart3 className="w-3.5 h-3.5" />
          <span>ЦБ и 5 Регионов</span>
        </button>

        <button
          onClick={onToggleChat}
          className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          title="Совет Полуострова и чат мэров"
        >
          <MessageSquare className="w-3.5 h-3.5 text-sky-400" />
          <span className="hidden md:inline">Совет</span>
        </button>

        <button
          onClick={onToggleAdmin}
          className="flex items-center gap-1 px-2 py-1 rounded bg-purple-950/80 hover:bg-purple-900 border border-purple-500/50 text-purple-200 transition"
          title="Панель разработчика / Бог-режим (клавиша ~)"
        >
          <ShieldAlert className="w-3.5 h-3.5 text-purple-400" />
          <span>~</span>
        </button>
      </div>
    </header>
  );
};
