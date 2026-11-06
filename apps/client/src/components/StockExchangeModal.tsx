import React, { useState } from "react";
import { AlertOctagon, Building2, Landmark, ShieldAlert, TrendingUp, X } from "lucide-react";
import {
  FOREIGN_TAKEOVER_NOTICE_THRESHOLD,
  formatMoney,
  mulRate,
  type ClientCommand,
  type SectorId,
  type WorldSnapshotDto,
} from "@pentapolis/shared-sim";

interface StockExchangeModalProps {
  snapshot: WorldSnapshotDto;
  activeSectorId: SectorId;
  onSendCommand: (cmd: ClientCommand) => void;
  onFocusTile: (tileX: number, tileY: number) => void;
  onClose: () => void;
}

type FilterMode = "all" | "mine" | "foreign" | "stalled";

export const StockExchangeModal: React.FC<StockExchangeModalProps> = ({
  snapshot,
  activeSectorId,
  onSendCommand,
  onFocusTile,
  onClose,
}) => {
  const [filter, setFilter] = useState<FilterMode>("all");
  const [stakePct, setStakePct] = useState<number>(10);
  const [source, setSource] = useState<"swf" | "treasury">("treasury");

  const activeSec = snapshot.sectors.find((s) => s.sectorId === activeSectorId) ?? snapshot.sectors[0]!;
  const hasExchangeFloor = snapshot.buildings.some(
    (b) => b.catalogId === "FIN-02" && b.constructionProgress >= 1
  );
  const buildingMap = new Map(snapshot.buildings.map((b) => [b.id, b]));
  const takeovers = snapshot.pendingTakeovers ?? [];
  const nowGameSeconds =
    ((snapshot.calendar.economicYear - 1) * 360 +
      (snapshot.calendar.economicMonth - 1) * 30 +
      (snapshot.calendar.economicDayOfMonth - 1)) *
      86_400 +
    snapshot.calendar.economicHourOfDay * 3600;

  const companies = snapshot.exchange.filter((c) => {
    if (filter === "mine") return c.sectorId === activeSectorId;
    if (filter === "foreign") return c.sectorId !== activeSectorId;
    if (filter === "stalled") return Boolean(c.stalledAwaitingPrivate);
    return true;
  });

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm p-2 sm:p-4">
      <div className="compact-modal w-full max-w-5xl max-h-[92vh] overflow-y-auto rounded-2xl bg-slate-950 border border-emerald-600/60 shadow-2xl text-xs text-slate-100 flex flex-col">
        {/* Sticky Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-4 py-2.5 bg-slate-950/95 border-b border-slate-800">
          <div className="flex items-center gap-2 font-bold text-sm text-emerald-300">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            <span>Региональная Фондовая Биржа и Рынок Капитала (5 секторов)</span>
            <span
              className={`px-2 py-0.5 rounded text-[10px] ${
                hasExchangeFloor ? "bg-emerald-900/70 text-emerald-200" : "bg-amber-900/70 text-amber-200"
              }`}
            >
              {hasExchangeFloor ? "FIN-02 работает: трансграничные торги открыты" : "Постройте FIN-02 для скупки акций соседей"}
            </span>
          </div>
          <button
            onClick={onClose}
            className="min-h-[36px] px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white flex items-center gap-1"
          >
            <X className="w-4 h-4" />
            <span>Закрыть</span>
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* Active Hostile Takeover Notice Windows (>25%) */}
          {takeovers.length > 0 && (
            <div className="space-y-2">
              {takeovers.map((tk) => {
                const daysLeft = Math.max(0.1, (tk.effectiveAtGameSeconds - nowGameSeconds) / 86_400);
                const isTargetMayor = tk.targetSectorId === activeSectorId;
                return (
                  <div
                    key={tk.id}
                    className="rounded-xl border border-amber-500/80 bg-amber-950/45 p-3 flex flex-wrap items-center justify-between gap-2"
                  >
                    <div className="flex items-start gap-2">
                      <AlertOctagon className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-bold text-amber-200">
                          Окно уведомления о враждебном поглощении (&gt;25% акций): «{tk.companyNameRu}» (S{tk.targetSectorId})
                        </div>
                        <div className="text-[11px] text-amber-100/90">
                          Сектор S{tk.bidderSectorId} депонировал <b>{formatMoney(BigInt(tk.bidPriceWcuMinor))} МРЕ</b> за пакет{" "}
                          <b>+{(tk.deltaShare * 100).toFixed(1)}%</b> (итоговая доля {(tk.resultingShare * 100).toFixed(1)}%). До закрытия реестра:{" "}
                          <b className="font-mono">{daysLeft.toFixed(1)} игр. дн.</b>
                        </div>
                      </div>
                    </div>
                    {isTargetMayor && (
                      <button
                        onClick={() =>
                          onSendCommand({
                            type: "preempt_takeover",
                            sectorId: activeSectorId,
                            takeoverId: tk.id,
                            source,
                          })
                        }
                        className="min-h-[40px] px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold flex items-center gap-1.5 shadow"
                      >
                        <ShieldAlert className="w-4 h-4" />
                        <span>Перекупить по праву первой руки ({formatMoney(BigInt(tk.bidPriceWcuMinor))} МРЕ)</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Top Controls: Filter Tabs + Deal Size + Funding Source */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-900/80 border border-slate-800 p-2.5">
            <div className="flex items-center gap-1 overflow-x-auto">
              {(
                [
                  { id: "all", label: `Все компании (${snapshot.exchange.length})` },
                  { id: "mine", label: `Мой сектор S${activeSectorId}` },
                  { id: "foreign", label: "Компании соседей" },
                  { id: "stalled", label: "Долгострои 10%/90%" },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setFilter(t.id)}
                  className={`min-h-[36px] px-3 py-1 rounded-lg font-medium whitespace-nowrap ${
                    filter === t.id ? "bg-emerald-700 text-white" : "bg-slate-950 text-slate-400 hover:text-white"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                <span className="text-slate-400">Пакет сделки:</span>
                <input
                  type="range"
                  min={1}
                  max={50}
                  value={stakePct}
                  onChange={(e) => setStakePct(Number(e.target.value))}
                  className="w-28 accent-emerald-500"
                />
                <span className="font-mono font-bold text-emerald-300 w-9 text-right">{stakePct}%</span>
              </label>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => setSource("treasury")}
                  className={`min-h-[36px] px-2.5 py-1 rounded-lg border text-[11px] font-medium ${
                    source === "treasury"
                      ? "bg-emerald-700 border-emerald-400 text-white"
                      : "bg-slate-950 border-slate-700 text-slate-300"
                  }`}
                >
                  <Landmark className="w-3 h-3 inline mr-1" />
                  Казна ({activeSec.currencySymbol} {formatMoney(BigInt(activeSec.treasuryBalanceMinor))})
                </button>
                <button
                  onClick={() => setSource("swf")}
                  className={`min-h-[36px] px-2.5 py-1 rounded-lg border text-[11px] font-medium ${
                    source === "swf"
                      ? "bg-violet-700 border-violet-400 text-white"
                      : "bg-slate-950 border-slate-700 text-slate-300"
                  }`}
                >
                  Фонд SWF ({formatMoney(BigInt(activeSec.swfBalanceWcuMinor))} МРЕ)
                </button>
              </div>
            </div>
          </div>

          {/* Companies Table */}
          {companies.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6 text-center text-slate-400">
              По выбранному фильтру пока нет предприятий. Стройте заводы Tier 2–4 (PRO-*, CMP-*, ASM-*) и Биржевую площадку (FIN-02).
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-900 text-slate-400 text-[11px] border-b border-slate-800">
                    <th className="p-2.5">Предприятие / Сектор</th>
                    <th className="p-2.5">Капитализация (МРЕ / Локал.)</th>
                    <th className="p-2.5">Див. доходность</th>
                    <th className="p-2.5 min-w-[200px]">Структура владения (Город / Fk / Иностр.)</th>
                    <th className="p-2.5 text-right">Операции с акциями</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80 bg-slate-950/60">
                  {companies.map((c) => {
                    const homeSec = snapshot.sectors.find((s) => s.sectorId === c.sectorId)!;
                    const own = c.sectorId === activeSectorId;
                    const foreignTotal = c.foreignStakes.reduce((s, f) => s + f.share, 0);
                    const myForeign = c.foreignStakes.find((f) => f.sectorId === activeSectorId)?.share ?? 0;
                    const capLocal = BigInt(c.marketCapLocalMinor);
                    const capWcu = c.marketCapWcuMinor
                      ? BigInt(c.marketCapWcuMinor)
                      : mulRate(capLocal, 1 / Math.max(0.01, homeSec.fxRatePerWcu));
                    const bld = buildingMap.get(c.buildingId);
                    const willTriggerTakeover =
                      !own && myForeign + stakePct / 100 > FOREIGN_TAKEOVER_NOTICE_THRESHOLD;

                    return (
                      <tr key={c.buildingId} className="hover:bg-slate-900/60">
                        <td className="p-2.5">
                          <button
                            onClick={() => {
                              if (bld) {
                                onFocusTile(bld.tileX + bld.width / 2, bld.tileY + bld.depth / 2);
                                onClose();
                              }
                            }}
                            className="font-semibold text-white hover:text-emerald-300 flex items-center gap-1.5 text-left"
                          >
                            <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span>
                              S{c.sectorId} · {c.nameRu} (Ур.{c.level})
                            </span>
                          </button>
                          {c.stalledAwaitingPrivate && (
                            <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded bg-amber-950 border border-amber-500/60 text-amber-300 text-[10px]">
                              ❄️ Долгострой: ждёт выкупа 90% пакета
                            </span>
                          )}
                        </td>

                        <td className="p-2.5 font-mono">
                          <div className="text-slate-100 font-semibold">{formatMoney(capWcu)} МРЕ</div>
                          <div className="text-[10px] text-slate-400">
                            {homeSec.currencySymbol} {formatMoney(capLocal)}
                          </div>
                        </td>

                        <td className="p-2.5 font-mono">
                          <span className="px-2 py-0.5 rounded bg-emerald-950/70 border border-emerald-700/50 text-emerald-300 font-semibold">
                            {(c.annualRoi * 100).toFixed(1)}% год.
                          </span>
                        </td>

                        <td className="p-2.5">
                          <div className="h-2.5 w-full rounded-full bg-slate-800 overflow-hidden flex">
                            <div
                              className="bg-sky-500 h-full"
                              style={{ width: `${Math.round(c.cityShare * 100)}%` }}
                              title={`Муниципалитет S${c.sectorId}: ${(c.cityShare * 100).toFixed(1)}%`}
                            />
                            <div
                              className="bg-emerald-500 h-full"
                              style={{ width: `${Math.round(c.privateShare * 100)}%` }}
                              title={`Местный частный капитал Fk: ${(c.privateShare * 100).toFixed(1)}%`}
                            />
                            <div
                              className="bg-violet-500 h-full"
                              style={{ width: `${Math.round(foreignTotal * 100)}%` }}
                              title={`Иностранные инвесторы: ${(foreignTotal * 100).toFixed(1)}%`}
                            />
                          </div>
                          <div className="text-[10px] text-slate-400 mt-1 flex flex-wrap gap-x-2">
                            <span className="text-sky-300">Город {(c.cityShare * 100).toFixed(0)}%</span>
                            <span className="text-emerald-300">Fk {(c.privateShare * 100).toFixed(0)}%</span>
                            {foreignTotal > 0 && (
                              <span className="text-violet-300">
                                Иностр. {(foreignTotal * 100).toFixed(0)}% (
                                {c.foreignStakes.map((f) => `S${f.sectorId}:${(f.share * 100).toFixed(0)}%`).join(", ")})
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="p-2.5 text-right">
                          {c.stalledAwaitingPrivate ? (
                            own ? (
                              <button
                                onClick={() =>
                                  onSendCommand({
                                    type: "buyout_factory",
                                    sectorId: activeSectorId,
                                    buildingId: c.buildingId,
                                  })
                                }
                                className="min-h-[38px] px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold"
                              >
                                Выкупить 100% в казну
                              </button>
                            ) : (
                              <span className="text-[10px] text-slate-500">Ожидает запуска мэром S{c.sectorId}</span>
                            )
                          ) : own ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() =>
                                  onSendCommand({
                                    type: "trade_stake",
                                    sectorId: activeSectorId,
                                    buildingId: c.buildingId,
                                    deltaShare: stakePct / 100,
                                    source,
                                  })
                                }
                                disabled={c.privateShare <= 0}
                                className="min-h-[38px] px-2.5 py-1 rounded-lg bg-sky-700 hover:bg-sky-600 disabled:opacity-40 text-white font-medium"
                              >
                                Муниц. выкуп +{stakePct}%
                              </button>
                              <button
                                onClick={() =>
                                  onSendCommand({
                                    type: "trade_stake",
                                    sectorId: activeSectorId,
                                    buildingId: c.buildingId,
                                    deltaShare: -stakePct / 100,
                                    source: "treasury",
                                  })
                                }
                                disabled={c.cityShare <= 0}
                                className="min-h-[38px] px-2.5 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white font-medium"
                                title="Продать муниципальную долю местному частному рынку Fk — выручка [Fk -> T] мгновенно в казну"
                              >
                                SPO Приватизация −{stakePct}%
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() =>
                                  onSendCommand({
                                    type: "trade_stake",
                                    sectorId: activeSectorId,
                                    buildingId: c.buildingId,
                                    deltaShare: stakePct / 100,
                                    source,
                                  })
                                }
                                disabled={c.privateShare <= 0 || !hasExchangeFloor}
                                className={`min-h-[38px] px-2.5 py-1 rounded-lg disabled:opacity-40 text-white font-medium ${
                                  willTriggerTakeover
                                    ? "bg-amber-700 hover:bg-amber-600"
                                    : "bg-violet-700 hover:bg-violet-600"
                                }`}
                                title={
                                  willTriggerTakeover
                                    ? "Доля превысит 25% — откроется 4-дневное Окно уведомления для мэра-хозяина"
                                    : "Купить пакет акций соседа"
                                }
                              >
                                {willTriggerTakeover ? `Оферта +${stakePct}% (>25%)` : `Купить +${stakePct}%`}
                              </button>
                              <button
                                onClick={() =>
                                  onSendCommand({
                                    type: "trade_stake",
                                    sectorId: activeSectorId,
                                    buildingId: c.buildingId,
                                    deltaShare: -stakePct / 100,
                                    source,
                                  })
                                }
                                disabled={myForeign <= 0 || !hasExchangeFloor}
                                className="min-h-[38px] px-2.5 py-1 rounded-lg bg-rose-900 hover:bg-rose-800 disabled:opacity-40 text-white font-medium"
                              >
                                Продать −{stakePct}%
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="text-[11px] text-slate-400">
            Правило защиты суверенитета (GDD §3.2): скупка иностранным сектором свыше <b>25%</b> акций предприятия включает{" "}
            <b>Окно уведомления (4 игровых дня)</b>, в течение которого домашняя Мэрия вправе перекупить этот пакет по праву первой руки. Все сделки и дивиденды проводятся через <code>RegionalMoneyEngine</code> с нулевым расхождением <code>0n</code>.
          </div>
        </div>
      </div>
    </div>
  );
};
