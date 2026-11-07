import React, { useState } from "react";
import {
  Atom,
  BarChart3,
  CheckCircle2,
  Compass,
  Landmark,
  Layers,
  MessageSquare,
  Shield,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  Users,
  Volume2,
  VolumeX,
  Bell,
  BellOff,
  Menu,
  X,
  Zap,
} from "lucide-react";
import { formatMoney, type SectorId, type WorldSnapshotDto } from "@pentapolis/shared-sim";
import type { PushState } from "../net/push.ts";
import type { HeatmapOverlayKind } from "../renderer/LotGenerator.ts";

interface TopHudBarProps {
  snapshot: WorldSnapshotDto;
  activeSectorId: SectorId;
  heatmapOverlay: HeatmapOverlayKind;
  onChangeHeatmapOverlay: (overlay: HeatmapOverlayKind) => void;
  onOpenRegionModal: () => void;
  onOpenMacroModal: () => void;
  onOpenKppModal: () => void;
  onOpenExchangeModal: () => void;
  onOpenMegaprojectModal: () => void;
  onToggleChat: () => void;
  onToggleAdmin: () => void;
  onFocusSector: (s: SectorId | "core") => void;
  onFocusOverview: () => void;
  audioMuted?: boolean;
  audioVolume?: number;
  onToggleMute?: () => void;
  onChangeVolume?: (volume: number) => void;
  pushState?: PushState;
  onTogglePush?: () => void;
}

const PUSH_TITLES: Readonly<Record<PushState, string>> = {
  unsupported: "Этот браузер не поддерживает Web Push (на iPhone — установите игру на экран «Домой»)",
  off: "Включить уведомления: окна уведомления соседей, ЧП, поглощения, ИИ-Губернатор",
  on: "Уведомления включены — нажмите, чтобы отключить",
  denied: "Уведомления запрещены в настройках браузера",
};

const OVERLAY_ITEMS: readonly { id: HeatmapOverlayKind; label: string; title: string }[] = [
  { id: "none", label: "Выкл", title: "Обычный 3D-вид зданий и крыш" },
  { id: "land_value", label: "Земля", title: "Тепловая карта стоимости земли (0..100: бедные P / средние M / элитные R)" },
  { id: "pollution", label: "Экология", title: "Тепловая карта промышленного загрязнения и свалок" },
  { id: "coverage", label: "Службы", title: "Покрытие школ, клиник, полиции, парков и станций ОТ" },
];

/** "9,85 млн" style amount for the HUD; the exact sum goes into the tooltip. */
function compactMoney(minor: bigint): string {
  const v = Number(minor) / 100;
  const abs = Math.abs(v);
  const fmt = (n: number, unit: string) => `${n.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${unit}`;
  if (abs >= 1e9) return fmt(v / 1e9, "млрд");
  if (abs >= 1e6) return fmt(v / 1e6, "млн");
  if (abs >= 1e4) return fmt(v / 1e3, "тыс.");
  return v.toLocaleString("ru-RU", { maximumFractionDigits: 0 });
}

export const TopHudBar: React.FC<TopHudBarProps> = ({
  snapshot,
  activeSectorId,
  heatmapOverlay,
  onChangeHeatmapOverlay,
  onOpenRegionModal,
  onOpenMacroModal,
  onOpenKppModal,
  onOpenExchangeModal,
  onOpenMegaprojectModal,
  onToggleChat,
  onToggleAdmin,
  onFocusSector,
  onFocusOverview,
  audioMuted = false,
  audioVolume = 0.55,
  onToggleMute,
  onChangeVolume,
  pushState = "unsupported",
  onTogglePush,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const sec = snapshot.sectors.find((s) => s.sectorId === activeSectorId) ?? snapshot.sectors[0]!;
  const treasuryFormatted = formatMoney(BigInt(sec.treasuryBalanceMinor));
  const treasuryShort = compactMoney(BigInt(sec.treasuryBalanceMinor));
  const cal = snapshot.calendar;
  const residents = snapshot.city.find((c) => c.sectorId === activeSectorId)?.residents ?? 0;
  const cityHouseholds = sec.cityHouseholds ?? 0;
  const next = sec.nextStage;
  const stageProgress = next ? Math.min(1, cityHouseholds / Math.max(1, next.minHouseholds)) : 1;
  const stageTitle = next
    ? `Стадия ${sec.stage}. До ${next.stage} «${next.nameRu}»: ${cityHouseholds.toLocaleString("ru-RU")} из ${next.minHouseholds.toLocaleString("ru-RU")} семей в построенных кварталах`
    : `Стадия ${sec.stage}: высшая`;

  return (
    <header className="pointer-events-auto relative z-40 flex items-center justify-between gap-2 px-3 py-1.5 bg-slate-950/90 backdrop-blur-md border-b border-slate-800 text-xs shadow-lg whitespace-nowrap">
      {/* Left: Active Sector + Treasury + FX */}
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={onOpenRegionModal}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-200 font-semibold transition"
          title="Выбрать или возглавить сектор"
        >
          <Landmark className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="max-w-[9rem] truncate compact:hidden">S{sec.sectorId}: {sec.cityName}</span>
          <span className="hidden compact:inline">S{sec.sectorId}</span>
        </button>

        {/* Development stage and progress to the next one */}
        <div
          className="flex items-center gap-1.5 px-2 py-1 rounded bg-slate-900 border border-slate-800"
          title={stageTitle}
        >
          <span className="px-1.5 py-0.5 rounded bg-amber-400/20 text-[10px] font-bold text-amber-300">{sec.stage}</span>
          {next && (
            <span className="hidden md:flex items-center gap-1.5">
              <span className="w-14 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <span className="block h-full bg-amber-400" style={{ width: `${Math.round(stageProgress * 100)}%` }} />
              </span>
              <span className="text-[10px] text-slate-400">→ {next.stage}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
          <span
            className="text-emerald-400 font-bold"
            title={`Казна: ${sec.currencySymbol} ${treasuryFormatted}`}
          >
            {sec.currencySymbol} {treasuryShort}
          </span>
          <span className="hidden 2xl:inline text-slate-600">|</span>
          <span className="hidden 2xl:inline text-sky-300" title="Плавающий курс к Мировой расчётной единице (МРЕ)">
            {sec.fxRatePerWcu.toFixed(3)} {sec.currencySymbol}/МРЕ
          </span>
          <span className="text-slate-600 compact:hidden">|</span>
          <span
            className={`compact:hidden ${
              sec.annualInflation > 0.08 ? "text-rose-400 font-medium" : "text-slate-300"
            }`}
            title={`Годовая инфляция; курс ${sec.fxRatePerWcu.toFixed(3)} ${sec.currencySymbol}/МРЕ`}
          >
            Инфл. {(sec.annualInflation * 100).toFixed(1)}%
          </span>
        </div>

        {/* Population, Happiness, Power */}
        <div className="hidden xl:flex items-center gap-3 px-2.5 py-1 rounded bg-slate-900/80 border border-slate-800 text-slate-200">
          <span
            className="flex items-center gap-1"
            title={`Жители построенных кварталов. Макроэкономика страны: ${sec.households.toLocaleString("ru-RU")} семей`}
          >
            <Users className="w-3.5 h-3.5 text-sky-400" />
            {residents.toLocaleString("ru-RU")}
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
      <div className="hidden xl:flex items-center gap-1 bg-slate-900/90 px-1.5 py-0.5 rounded border border-slate-800">
        {([1, 2, 3, 4, 5] as const).map((sId) => (
          <button
            key={sId}
            onClick={() => onFocusSector(sId)}
            className={`hidden 2xl:inline-block px-1.5 py-0.5 rounded text-[11px] font-medium transition ${
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

        <span className="text-slate-700 px-0.5">|</span>
        <label
          className={`flex items-center gap-1 px-1 rounded ${heatmapOverlay !== "none" ? "bg-emerald-600/30" : ""}`}
          title={OVERLAY_ITEMS.find((o) => o.id === heatmapOverlay)?.title}
        >
          <Layers className="w-3.5 h-3.5 text-slate-400" />
          <select
            value={heatmapOverlay}
            onChange={(e) => onChangeHeatmapOverlay(e.target.value as HeatmapOverlayKind)}
            className="bg-transparent text-[11px] text-slate-200 outline-none cursor-pointer"
            aria-label="Тепловая карта"
          >
            {OVERLAY_ITEMS.map((ov) => (
              <option key={ov.id} value={ov.id} className="bg-slate-900">
                {ov.id === "none" ? "Карта: обычная" : ov.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Right: Dual Calendar + Double-Entry Audit Badge + Action Buttons */}
      <div className="flex items-center gap-2">
        {/* The 7-column double-entry audit is silent while it balances; it only speaks up on an error */}
        {!snapshot.invariantAllZero && (
          <div
            className="flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-mono bg-rose-950/80 border-rose-500 text-rose-200"
            title="Нарушен инвариант двойной записи (7 колонок): откройте «ЦБ и 5 регионов»"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>ERR</span>
          </div>
        )}

        <div
          className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800 font-mono text-[11px] text-slate-200"
          title={`Экономический календарь: день ${cal.economicDayOfMonth}, месяц ${cal.economicMonth}, год ${cal.economicYear}. Жизнь горожан: ${cal.citizenLifeYearsElapsed.toFixed(1)} лет. Сезон: день ${snapshot.seasonDay}/30`}
        >
          <span className="compact:hidden">
            {String(cal.economicDayOfMonth).padStart(2, "0")}.{String(cal.economicMonth).padStart(2, "0")} · Г
            {cal.economicYear}{" "}
          </span>
          <span className="text-slate-400">
            {String(cal.economicHourOfDay).padStart(2, "0")}:{String(cal.economicMinuteOfHour).padStart(2, "0")}
          </span>
        </div>

        <div className="flex items-center gap-2 compact:hidden">
        <button
          onClick={onOpenKppModal}
          className="flex items-center gap-1 px-2 py-1 rounded bg-cyan-900/70 hover:bg-cyan-800 text-cyan-100 border border-cyan-600/50 font-medium transition"
          title="Пограничные КПП, пошлины, санкарантин и газовый вентиль"
        >
          <Shield className="w-3.5 h-3.5 text-cyan-300" />
          <span className="hidden 2xl:inline">КПП</span>
        </button>

        <button
          onClick={onOpenExchangeModal}
          className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-900/70 hover:bg-emerald-800 text-emerald-100 border border-emerald-600/50 font-medium transition"
          title="Региональная фондовая биржа, SPO приватизация и поглощения"
        >
          <TrendingUp className="w-3.5 h-3.5 text-emerald-300" />
          <span className="hidden 2xl:inline">Биржа</span>
          {(snapshot.pendingTakeovers?.length ?? 0) > 0 && (
            <span className="px-1 rounded bg-amber-500 text-slate-950 font-bold text-[10px]">
              {snapshot.pendingTakeovers!.length}
            </span>
          )}
        </button>

        <button
          onClick={onOpenMegaprojectModal}
          className="flex items-center gap-1 px-2 py-1 rounded bg-violet-900/70 hover:bg-violet-800 text-violet-100 border border-violet-600/50 font-medium transition"
          title="Кооперативные Мегапроекты Центрального Ядра (MEG-01..04)"
        >
          <Atom className="w-3.5 h-3.5 text-violet-300" />
          <span className="hidden 2xl:inline">Мегапроекты</span>
        </button>

        <button
          onClick={onOpenMacroModal}
          title="Центральный банк, бюджет и макроэкономика 5 регионов"
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium transition"
        >
          <BarChart3 className="w-3.5 h-3.5" />
          <span className="hidden 2xl:inline">ЦБ и регионы</span>
          <span className="2xl:hidden">ЦБ</span>
        </button>

        <button
          onClick={onToggleChat}
          className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          title="Совет Полуострова и чат мэров"
        >
          <MessageSquare className="w-3.5 h-3.5 text-sky-400" />
          <span className="hidden 2xl:inline">Совет</span>
        </button>

        {onToggleMute && (
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700">
            <button
              onClick={onToggleMute}
              className="p-0.5 text-slate-300 hover:text-white transition"
              title={audioMuted ? "Включить процедурный звук и 3D-амбиент" : "Выключить звук"}
            >
              {audioMuted || audioVolume === 0 ? (
                <VolumeX className="w-3.5 h-3.5 text-rose-400" />
              ) : (
                <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
              )}
            </button>
            {onChangeVolume && (
              <input
                type="range"
                min={0}
                max={100}
                value={audioMuted ? 0 : Math.round(audioVolume * 100)}
                onChange={(e) => onChangeVolume(Number(e.target.value) / 100)}
                className="hidden 2xl:block w-14 h-1 accent-emerald-400 cursor-pointer"
                title={`Громкость звука: ${Math.round((audioMuted ? 0 : audioVolume) * 100)}%`}
              />
            )}
          </div>
        )}

        {onTogglePush && (
          <button
            onClick={onTogglePush}
            disabled={pushState === "unsupported" || pushState === "denied"}
            className="flex items-center px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition disabled:opacity-40"
            title={PUSH_TITLES[pushState]}
            aria-label="Уведомления"
          >
            {pushState === "on" ? <Bell className="w-3.5 h-3.5 text-amber-300" /> : <BellOff className="w-3.5 h-3.5 text-slate-400" />}
          </button>
        )}

        <button
          onClick={onToggleAdmin}
          className="flex items-center gap-1 px-2 py-1 rounded bg-purple-950/80 hover:bg-purple-900 border border-purple-500/50 text-purple-200 transition"
          title="Панель разработчика / Бог-режим (клавиша ~)"
        >
          <ShieldAlert className="w-3.5 h-3.5 text-purple-400" />
          <span>~</span>
        </button>
        </div>

        {/* Phones: every action in one menu */}
        <div className="relative hidden compact:block">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-100"
            aria-label="Меню"
          >
            {menuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            {(snapshot.pendingTakeovers?.length ?? 0) > 0 && !menuOpen && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-500" />
            )}
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-56 max-h-[calc(100dvh-4rem)] overflow-y-auto rounded-xl bg-slate-950/95 backdrop-blur-md border border-slate-700 shadow-2xl p-1.5 text-[13px] whitespace-normal">
              {[
                { label: "ЦБ и регионы", icon: BarChart3, on: onOpenMacroModal },
                { label: "Пограничные КПП", icon: Shield, on: onOpenKppModal },
                { label: `Биржа${(snapshot.pendingTakeovers?.length ?? 0) > 0 ? ` (${snapshot.pendingTakeovers!.length})` : ""}`, icon: TrendingUp, on: onOpenExchangeModal },
                { label: "Мегапроекты", icon: Atom, on: onOpenMegaprojectModal },
                { label: "Совет мэров", icon: MessageSquare, on: onToggleChat },
                { label: "Обзор полуострова", icon: Compass, on: onFocusOverview },
              ].map((item) => (
                <button
                  key={item.label}
                  onClick={() => {
                    setMenuOpen(false);
                    item.on();
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-slate-100 hover:bg-slate-800"
                >
                  <item.icon className="w-4 h-4 text-slate-300" />
                  {item.label}
                </button>
              ))}
              <div className="my-1 border-t border-slate-800" />
              <label className="flex items-center gap-2 px-2.5 py-2 text-slate-300">
                <Layers className="w-4 h-4" />
                <select
                  value={heatmapOverlay}
                  onChange={(e) => onChangeHeatmapOverlay(e.target.value as HeatmapOverlayKind)}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-slate-100"
                >
                  {OVERLAY_ITEMS.map((ov) => (
                    <option key={ov.id} value={ov.id}>
                      {ov.id === "none" ? "Карта: обычная" : ov.label}
                    </option>
                  ))}
                </select>
              </label>
              {onToggleMute && (
                <button
                  onClick={onToggleMute}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-slate-100 hover:bg-slate-800"
                >
                  {audioMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4 text-emerald-400" />}
                  {audioMuted ? "Включить звук" : "Выключить звук"}
                </button>
              )}
              {onTogglePush && (
                <button
                  onClick={onTogglePush}
                  disabled={pushState === "unsupported" || pushState === "denied"}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-slate-100 hover:bg-slate-800 disabled:opacity-40"
                >
                  {pushState === "on" ? <Bell className="w-4 h-4 text-amber-300" /> : <BellOff className="w-4 h-4 text-slate-400" />}
                  {pushState === "on" ? "Уведомления включены" : pushState === "unsupported" ? "Уведомления: добавьте игру на экран «Домой»" : "Включить уведомления"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
