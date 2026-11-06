import React, { useEffect, useState } from "react";
import { AlertTriangle, Flame, MapPin, Shield, ShieldCheck, Truck, Users, X } from "lucide-react";
import {
  CARGO_LANES,
  LANE_NAMES_RU,
  VISA_NAMES_RU,
  formatMoney,
  mulRate,
  type BorderSidePolicyDto,
  type CargoLaneId,
  type ClientCommand,
  type SectorId,
  type VisaRegimeId,
  type WorldSnapshotDto,
} from "@pentapolis/shared-sim";

interface BorderKppModalProps {
  snapshot: WorldSnapshotDto;
  activeSectorId: SectorId;
  initialPostId?: string | null;
  onSendCommand: (cmd: ClientCommand) => void;
  onFocusTile: (tileX: number, tileY: number) => void;
  onSelectBuildKpp?: () => void;
  onClose: () => void;
}

type HighLevelStatus = "open" | "quota" | "blockade";

function deriveHighLevelStatus(side: BorderSidePolicyDto): HighLevelStatus {
  if (side.visaRegime === "closed" || side.embargo.length === CARGO_LANES.length) return "blockade";
  if (side.visaRegime === "skilled_quota" || side.inspection === "strict" || side.embargo.length > 0) return "quota";
  return "open";
}

export const BorderKppModal: React.FC<BorderKppModalProps> = ({
  snapshot,
  activeSectorId,
  initialPostId,
  onSendCommand,
  onFocusTile,
  onSelectBuildKpp,
  onClose,
}) => {
  const posts = snapshot.borderPosts;
  const defaultPost =
    (initialPostId ? posts.find((p) => p.id === initialPostId) : undefined) ??
    posts.find((p) => p.sectorA === activeSectorId || p.sectorB === activeSectorId) ??
    posts[0] ??
    null;

  const [selectedPostId, setSelectedPostId] = useState<string | null>(defaultPost?.id ?? null);
  const post = posts.find((p) => p.id === selectedPostId) ?? defaultPost;
  const stats = post ? snapshot.borderStats.find((s) => s.postId === post.id) : undefined;
  const mine = post?.sides.find((s) => s.sectorId === activeSectorId) ?? null;

  const [draft, setDraft] = useState<BorderSidePolicyDto | null>(mine);

  useEffect(() => {
    setDraft(mine);
  }, [post?.id, activeSectorId, mine?.visaRegime, mine?.inspection, mine?.sanitaryQuarantine, mine?.gasValveOpen]);

  const symOf = (s: SectorId) => snapshot.sectors.find((x) => x.sectorId === s)?.currencySymbol ?? "";
  const fxOf = (s: SectorId) => snapshot.sectors.find((x) => x.sectorId === s)?.fxRatePerWcu ?? 1;

  const applyStatusPreset = (preset: HighLevelStatus) => {
    if (!draft) return;
    if (preset === "open") {
      setDraft({ ...draft, visaRegime: "visa_free", embargo: [], inspection: "green" });
    } else if (preset === "quota") {
      setDraft({ ...draft, visaRegime: "skilled_quota", inspection: "strict" });
    } else {
      setDraft({ ...draft, visaRegime: "closed", embargo: [...CARGO_LANES], inspection: "strict" });
    }
  };

  const setDuty = (lane: CargoLaneId, kind: "importDuty" | "exportDuty" | "transitDuty", pctVal: number) => {
    if (!draft) return;
    const rate = Math.max(0, Math.min(1, pctVal / 100));
    if (kind === "transitDuty") {
      const base = draft.transitDuty ?? { raw: 0.03, hydrocarbons: 0.03, agri: 0.03, manufactured: 0.03, luxury: 0.03 };
      setDraft({ ...draft, transitDuty: { ...base, [lane]: rate } });
    } else {
      setDraft({ ...draft, [kind]: { ...draft[kind], [lane]: rate } });
    }
  };

  const toggleEmbargo = (lane: CargoLaneId) => {
    if (!draft) return;
    setDraft({
      ...draft,
      embargo: draft.embargo.includes(lane) ? draft.embargo.filter((l) => l !== lane) : [...draft.embargo, lane],
    });
  };

  const handleApply = () => {
    if (!post || !draft) return;
    onSendCommand({
      type: "set_border_policy",
      sectorId: activeSectorId,
      postId: post.id,
      visaRegime: draft.visaRegime,
      importDuty: { ...draft.importDuty },
      exportDuty: { ...draft.exportDuty },
      transitDuty: draft.transitDuty ? { ...draft.transitDuty } : undefined,
      embargo: [...draft.embargo],
      inspection: draft.inspection,
      sanitaryQuarantine: Boolean(draft.sanitaryQuarantine),
      gasValveOpen: draft.gasValveOpen !== false,
    });
  };

  const handleToggleGasValve = () => {
    if (!post || !mine) return;
    const nextOpen = mine.gasValveOpen === false;
    onSendCommand({
      type: "set_gas_valve",
      sectorId: activeSectorId,
      postId: post.id,
      open: nextOpen,
    });
  };

  const neighbor = post ? (post.sectorA === activeSectorId ? post.sectorB : post.sectorA) : null;
  const theirs = post && neighbor ? post.sides.find((s) => s.sectorId === neighbor) : undefined;
  const statusPreset = draft ? deriveHighLevelStatus(draft) : "open";

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm p-2 sm:p-4">
      <div className="compact-modal w-full max-w-4xl max-h-[92vh] overflow-y-auto rounded-2xl bg-slate-950 border border-cyan-600/60 shadow-2xl text-xs text-slate-100 flex flex-col">
        {/* Sticky Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-4 py-2.5 bg-slate-950/95 border-b border-slate-800">
          <div className="flex items-center gap-2 font-bold text-sm text-cyan-300">
            <Shield className="w-4 h-4 text-cyan-400" />
            <span>Пограничные КПП, Таможня и Транзит (Сектор S{activeSectorId})</span>
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
          {posts.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 text-center space-y-3">
              <div className="text-sm font-semibold text-cyan-200">На границах полуострова пока не построено ни одного КПП</div>
              <p className="text-slate-400 max-w-xl mx-auto">
                Разместите здание <b>Пограничный таможенный пост (LOG-07)</b> прямо на сухопутной границе вашего сектора с соседом и подведите к нему дороги, газопровод или ЛЭП с обеих сторон.
              </p>
              {onSelectBuildKpp && (
                <button
                  onClick={() => {
                    onSelectBuildKpp();
                    onClose();
                  }}
                  className="min-h-[40px] px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold"
                >
                  Выбрать постройку КПП (LOG-07) на карте
                </button>
              )}
            </div>
          ) : (
            <>
              {/* KPP Tabs */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                {posts.map((p) => {
                  const isMine = p.sectorA === activeSectorId || p.sectorB === activeSectorId;
                  const active = post?.id === p.id;
                  return (
                    <button
                      key={p.id}
                      onClick={() => setSelectedPostId(p.id)}
                      className={`min-h-[38px] px-3 py-1.5 rounded-lg border whitespace-nowrap font-semibold transition ${
                        active
                          ? "bg-cyan-700 border-cyan-400 text-white"
                          : isMine
                            ? "bg-slate-900 border-cyan-800/70 text-cyan-200 hover:bg-slate-800"
                            : "bg-slate-900/60 border-slate-800 text-slate-400 hover:bg-slate-800"
                      }`}
                    >
                      КПП #{p.id}: S{p.sectorA} ↔ S{p.sectorB} {isMine ? "★" : ""}
                    </button>
                  );
                })}
                {post && (
                  <button
                    onClick={() => {
                      onFocusTile(post.tileX + post.width / 2, post.tileY + post.depth / 2);
                      onClose();
                    }}
                    className="min-h-[38px] ml-auto px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 flex items-center gap-1 whitespace-nowrap"
                  >
                    <MapPin className="w-3.5 h-3.5" />
                    <span>Показать на карте</span>
                  </button>
                )}
              </div>

              {/* Monthly Summary Cards */}
              {post && stats && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <div className="rounded-xl bg-slate-900 border border-slate-800 p-2.5">
                    <div className="text-[10px] text-slate-400 flex items-center gap-1">
                      <Truck className="w-3.5 h-3.5 text-amber-400" /> Грузопоток фур
                    </div>
                    <div className="text-sm font-bold font-mono text-white mt-0.5">
                      {Math.round(stats.trucksPerHour * 720).toLocaleString("ru-RU")} фур/мес
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {stats.trucksPerHour} / {stats.capacityTrucksPerHour} фур/ч ·{" "}
                      <span className={stats.roadLinked ? "text-emerald-400" : "text-rose-400"}>
                        {stats.roadLinked ? "дороги стыкованы" : "нет стыковки дорог"}
                      </span>
                    </div>
                  </div>

                  <div className="rounded-xl bg-slate-900 border border-slate-800 p-2.5">
                    <div className="text-[10px] text-slate-400 flex items-center gap-1">
                      <Users className="w-3.5 h-3.5 text-sky-400" /> Пассажиры и мигранты
                    </div>
                    <div className="text-sm font-bold font-mono text-white mt-0.5">
                      {stats.crossersPerMonth.toLocaleString("ru-RU")} чел./мес
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {post.sides.some((s) => s.sanitaryQuarantine)
                        ? "Санкарантин: поток перекрыт"
                        : "Легковые авто и визовый поток"}
                    </div>
                  </div>

                  <div className="rounded-xl bg-slate-900 border border-slate-800 p-2.5">
                    <div className="text-[10px] text-slate-400">Сбор пошлин и виз (в мес.)</div>
                    {stats.revenue.map((r) => {
                      const locTotal = BigInt(r.dutyMinor) + BigInt(r.visaMinor);
                      const wcuTotal = mulRate(locTotal, 1 / Math.max(0.01, fxOf(r.sectorId)));
                      return (
                        <div key={r.sectorId} className="font-mono text-[11px] text-emerald-300 mt-0.5">
                          S{r.sectorId}: {symOf(r.sectorId)} {formatMoney(locTotal)} ({formatMoney(wcuTotal)} МРЕ)
                        </div>
                      );
                    })}
                  </div>

                  <div className="rounded-xl bg-slate-900 border border-slate-800 p-2.5">
                    <div className="text-[10px] text-slate-400">Средняя задержка на границе</div>
                    <div
                      className={`text-sm font-bold font-mono mt-0.5 ${
                        stats.queueMinutes >= 120 ? "text-rose-400" : stats.queueMinutes >= 60 ? "text-amber-300" : "text-emerald-300"
                      }`}
                    >
                      {stats.queueMinutes} мин
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {stats.queueMinutes >= 120 ? "🚨 Блокада КПП (>120 мин)" : "Норма пропуска (<120 мин)"}
                    </div>
                  </div>
                </div>
              )}

              {/* Active Pending Notice Windows */}
              {post &&
                post.pending.map((p) => (
                  <div
                    key={p.sectorId}
                    className="px-3 py-2 rounded-lg border border-amber-500/60 bg-amber-950/40 text-amber-100 text-[11px] flex items-center gap-2"
                  >
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Окно уведомления (3–6 игр. дней): {p.descriptionRu}</span>
                  </div>
                ))}

              {/* Neighbour Side Readout */}
              {post && theirs && neighbor && (
                <div className="rounded-lg bg-slate-900/70 border border-slate-800 px-3 py-2 text-[11px] text-slate-300 flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-200">Соседняя сторона (Сектор S{neighbor}):</span>
                  <span className="px-2 py-0.5 rounded bg-slate-800 text-cyan-200">{VISA_NAMES_RU[theirs.visaRegime]}</span>
                  <span>Досмотр: {theirs.inspection === "strict" ? "жёсткий" : "зелёный коридор"}</span>
                  {theirs.sanitaryQuarantine && (
                    <span className="px-2 py-0.5 rounded bg-emerald-950 border border-emerald-600 text-emerald-300">
                      Санкарантин активен
                    </span>
                  )}
                  {theirs.gasValveOpen === false && (
                    <span className="px-2 py-0.5 rounded bg-rose-950 border border-rose-600 text-rose-300">
                      Газовый вентиль перекрыт соседом!
                    </span>
                  )}
                </div>
              )}

              {/* Controls for Active Sector's Side */}
              {post && mine && draft ? (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 pt-1">
                  {/* Left: Regime, Quarantine & Gas Valve */}
                  <div className="lg:col-span-5 space-y-2.5 rounded-xl bg-slate-900/80 border border-slate-800 p-3">
                    <div className="font-bold text-cyan-200">Режим границы вашей стороны (S{activeSectorId})</div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(
                        [
                          { id: "open", label: "Открыто" },
                          { id: "quota", label: "Квотирование" },
                          { id: "blockade", label: "Полная блокада" },
                        ] as const
                      ).map((st) => (
                        <button
                          key={st.id}
                          onClick={() => applyStatusPreset(st.id)}
                          className={`min-h-[40px] px-2 py-1.5 rounded-lg border font-semibold text-[11px] transition ${
                            statusPreset === st.id
                              ? st.id === "blockade"
                                ? "bg-rose-700 border-rose-400 text-white"
                                : "bg-cyan-700 border-cyan-400 text-white"
                              : "bg-slate-950 border-slate-700 text-slate-300 hover:bg-slate-800"
                          }`}
                        >
                          {st.label}
                        </button>
                      ))}
                    </div>

                    <div className="text-[11px] text-slate-400 pt-1">Пассажирский и визовый режим:</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {(["visa_free", "paid_visa", "skilled_quota", "closed"] as VisaRegimeId[]).map((v) => (
                        <button
                          key={v}
                          onClick={() => setDraft({ ...draft, visaRegime: v })}
                          className={`min-h-[38px] px-2 py-1 rounded border text-[11px] ${
                            draft.visaRegime === v
                              ? "bg-sky-700 border-sky-400 text-white font-semibold"
                              : "bg-slate-950 border-slate-800 text-slate-300 hover:bg-slate-800"
                          }`}
                        >
                          {VISA_NAMES_RU[v]}
                        </button>
                      ))}
                    </div>

                    {/* Sanitary Quarantine */}
                    <label className="flex items-start gap-2.5 p-2.5 rounded-lg bg-emerald-950/30 border border-emerald-700/50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(draft.sanitaryQuarantine)}
                        onChange={(e) => setDraft({ ...draft, sanitaryQuarantine: e.target.checked })}
                        className="mt-0.5 w-4 h-4 accent-emerald-500"
                      />
                      <div>
                        <div className="font-semibold text-emerald-300 flex items-center gap-1">
                          <ShieldCheck className="w-3.5 h-3.5" /> Санитарный карантин (−90% риск эпидемий)
                        </div>
                        <div className="text-[10px] text-slate-400">
                          Полностью блокирует пассажирский и миграционный поток через КПП, сохраняя проезд грузовых фур.
                        </div>
                      </div>
                    </label>

                    <label className="flex items-center gap-2 px-2 py-1.5 rounded bg-slate-950 border border-slate-800 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.inspection === "strict"}
                        onChange={() =>
                          setDraft({ ...draft, inspection: draft.inspection === "strict" ? "green" : "strict" })
                        }
                        className="w-4 h-4 accent-cyan-500"
                      />
                      <span className="text-[11px]">Жёсткий таможенный досмотр (контрабанда ×0.5, пропускная ×0.5)</span>
                    </label>

                    {/* Emergency Gas Pipeline Valve */}
                    <div className="p-2.5 rounded-lg bg-amber-950/30 border border-amber-700/50 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-amber-300 flex items-center gap-1">
                          <Flame className="w-3.5 h-3.5" /> Магистральный газовый вентиль
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            mine.gasValveOpen !== false
                              ? "bg-emerald-900/70 text-emerald-200"
                              : "bg-rose-900/80 text-rose-200"
                          }`}
                        >
                          {mine.gasValveOpen !== false ? "ОТКРЫТ" : "ПЕРЕКРЫТ"}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-400">
                        Экстренное перекрытие мгновенно лишает импортёра бонуса +40% на заводах и переводит газовые ТЭС (ENG-02) на мазут (45% выработки).
                      </p>
                      <button
                        onClick={handleToggleGasValve}
                        className={`w-full min-h-[40px] px-3 py-1.5 rounded-lg font-semibold transition ${
                          mine.gasValveOpen !== false
                            ? "bg-rose-800 hover:bg-rose-700 text-white"
                            : "bg-emerald-700 hover:bg-emerald-600 text-white"
                        }`}
                      >
                        {mine.gasValveOpen !== false
                          ? "Перекрыть газовый вентиль соседу"
                          : "Открыть подачу газа через КПП"}
                      </button>
                    </div>
                  </div>

                  {/* Right: 0-100% Import & Transit Tariff Sliders */}
                  <div className="lg:col-span-7 space-y-2.5 rounded-xl bg-slate-900/80 border border-slate-800 p-3 flex flex-col justify-between">
                    <div className="space-y-2">
                      <div className="font-bold text-cyan-200">
                        Ставки ввозных и транзитных пошлин по группам грузов (0% – 100%)
                      </div>
                      <div className="space-y-2">
                        {CARGO_LANES.map((lane) => {
                          const impPct = Math.round((draft.importDuty[lane] ?? 0) * 100);
                          const trnPct = Math.round((draft.transitDuty?.[lane] ?? 0.03) * 100);
                          const expPct = Math.round((draft.exportDuty[lane] ?? 0) * 100);
                          const embargoed = draft.embargo.includes(lane);
                          return (
                            <div
                              key={lane}
                              className="rounded-lg bg-slate-950 border border-slate-800 p-2 space-y-1.5"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-semibold text-slate-200">{LANE_NAMES_RU[lane]}</span>
                                <label className="flex items-center gap-1.5 text-[11px] text-rose-300 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={embargoed}
                                    onChange={() => toggleEmbargo(lane)}
                                    className="w-3.5 h-3.5 accent-rose-500"
                                  />
                                  <span>Эмбарго</span>
                                </label>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-center text-[11px]">
                                <label className="flex flex-col gap-0.5">
                                  <span className="text-slate-400 flex justify-between">
                                    <span>Ввоз:</span>
                                    <b className={impPct > 50 ? "text-amber-400 font-mono" : "text-cyan-300 font-mono"}>
                                      {impPct}%
                                    </b>
                                  </span>
                                  <input
                                    type="range"
                                    min={0}
                                    max={100}
                                    value={Math.min(100, impPct)}
                                    onChange={(e) => setDuty(lane, "importDuty", Number(e.target.value))}
                                    className="w-full accent-cyan-500"
                                  />
                                </label>

                                <label className="flex flex-col gap-0.5">
                                  <span className="text-slate-400 flex justify-between">
                                    <span>Транзит:</span>
                                    <b className={trnPct > 50 ? "text-amber-400 font-mono" : "text-violet-300 font-mono"}>
                                      {trnPct}%
                                    </b>
                                  </span>
                                  <input
                                    type="range"
                                    min={0}
                                    max={100}
                                    value={Math.min(100, trnPct)}
                                    onChange={(e) => setDuty(lane, "transitDuty", Number(e.target.value))}
                                    className="w-full accent-violet-500"
                                  />
                                </label>

                                <label className="flex flex-col gap-0.5">
                                  <span className="text-slate-400 flex justify-between">
                                    <span>Вывоз:</span>
                                    <b className="text-emerald-300 font-mono">{expPct}%</b>
                                  </span>
                                  <input
                                    type="range"
                                    min={0}
                                    max={50}
                                    value={Math.min(50, expPct)}
                                    onChange={(e) => setDuty(lane, "exportDuty", Number(e.target.value))}
                                    className="w-full accent-emerald-500"
                                  />
                                </label>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="space-y-2 pt-2 border-t border-slate-800">
                      <div className="text-[10px] text-slate-400">
                        Повышение пошлин свыше 50%, новое эмбарго или блокада запускают <b>Окно уведомления (3–6 игр. дней)</b>. Все сборы проводятся через матрицу двойной записи <code>RegionalMoneyEngine</code> (0.00 расхождений).
                      </div>
                      <button
                        onClick={handleApply}
                        className="w-full min-h-[42px] px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs shadow-lg transition"
                      >
                        Утвердить таможенную и карантинную политику КПП #{post.id}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 text-center text-slate-400">
                  Этот КПП расположен на границе секторов S{post?.sectorA} и S{post?.sectorB}. Управлять его шлагбаумами, пошлинами и газовым вентилем могут мэры этих двух секторов.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
