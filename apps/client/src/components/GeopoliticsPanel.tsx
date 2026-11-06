import React, { useState } from "react";
import { Globe2, X, Zap } from "lucide-react";
import { formatMoney, type ClientCommand, type SectorId, type WorldSnapshotDto } from "@pentapolis/shared-sim";

interface GeopoliticsPanelProps {
  snapshot: WorldSnapshotDto;
  activeSectorId: SectorId;
  onSendCommand: (cmd: ClientCommand) => void;
  onFocusTile: (tileX: number, tileY: number) => void;
  onOpenKppModal?: () => void;
  onOpenExchangeModal?: () => void;
  onOpenMegaprojectModal?: () => void;
  onClose: () => void;
}

type Tab = "mega" | "exchange" | "energy" | "funds";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "mega", label: "Мегапроекты" },
  { id: "exchange", label: "Биржа" },
  { id: "energy", label: "Газ и ЛЭП" },
  { id: "funds", label: "Фонд и МВФ" },
];

const STATUS_RU = { funding: "Сбор взносов", building: "Стройка", operational: "Работает" } as const;
const wcu = (minor: string) => `${formatMoney(BigInt(minor))} МРЕ`;

/**
 * Geopolitics (Sprint 7, GDD §3.2, §9.1): Central Core megaprojects, the regional exchange,
 * gas & the power ring, and the Sovereign Wealth Fund / IMF position.
 */
export const GeopoliticsPanel: React.FC<GeopoliticsPanelProps> = ({
  snapshot,
  activeSectorId,
  onSendCommand,
  onFocusTile,
  onOpenKppModal,
  onOpenExchangeModal,
  onOpenMegaprojectModal,
  onClose,
}) => {
  const [tab, setTab] = useState<Tab>("mega");
  const [amount, setAmount] = useState(10_000_000);
  const [source, setSource] = useState<"treasury" | "swf">("swf");
  const [stakePct, setStakePct] = useState(5);
  const sec = snapshot.sectors.find((s) => s.sectorId === activeSectorId)!;
  const gas = snapshot.gas.find((g) => g.sectorId === activeSectorId);
  const ring = snapshot.powerRing.find((r) => r.sectorId === activeSectorId);
  const buildings = new Map(snapshot.buildings.map((b) => [b.id, b]));

  const sourceToggle = (
    <div className="flex gap-1">
      {(["swf", "treasury"] as const).map((s) => (
        <button
          key={s}
          onClick={() => setSource(s)}
          className={`flex-1 px-1.5 py-0.5 rounded border text-[10px] ${source === s ? "bg-violet-700 border-violet-400 text-white" : "border-slate-700 text-slate-300"}`}
        >
          {s === "swf" ? `Фонд (${formatMoney(BigInt(sec.swfBalanceWcuMinor))} МРЕ)` : "Казна"}
        </button>
      ))}
    </div>
  );

  return (
    <div className="compact-modal rounded-xl bg-slate-950/95 backdrop-blur-md border border-violet-700/60 shadow-2xl p-3 text-xs space-y-2.5">
      <div className="compact-modal-header flex items-center justify-between bg-slate-950/95 border-b border-slate-800 pb-2">
        <div className="flex items-center gap-1.5 font-bold text-violet-300">
          <Globe2 className="w-4 h-4" />
          <span>Геополитика S{activeSectorId}</span>
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
            className={`flex-1 px-1 py-1 rounded text-[10px] ${tab === t.id ? "bg-violet-700 text-white" : "text-slate-400 hover:bg-slate-800"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "mega" && (
        <div className="space-y-2">
          {onOpenMegaprojectModal && (
            <button
              onClick={onOpenMegaprojectModal}
              className="w-full py-1.5 px-2 rounded bg-violet-700 hover:bg-violet-600 text-white font-semibold text-[11px]"
            >
              Открыть полный зал Мегапроектов (MEG-01..04 + караваны)
            </button>
          )}
          {snapshot.megaprojects.length === 0 && (
            <div className="text-[11px] text-slate-500">
              Мегапроектов пока нет. Заложите MEG-01/02/03 в Центральном Ядре через «Каталог → Мегапроекты Ядра» — стройка
              начнётся, когда взносы мэров покроют стоимость. Доля = вклад, дивиденды пожизненно.
            </div>
          )}
          {snapshot.megaprojects.map((m) => {
            const funded = Number((BigInt(m.fundedWcuMinor) * 1000n) / BigInt(m.costWcuMinor)) / 10;
            const my = m.stakes.find((s) => s.sectorId === activeSectorId);
            const b = buildings.get(m.buildingId);
            return (
              <div key={m.buildingId} className="rounded border border-slate-800 bg-slate-900 p-2 space-y-1">
                <button onClick={() => b && onFocusTile(b.tileX + b.width / 2, b.tileY + b.depth / 2)} className="font-semibold text-left hover:text-violet-300">
                  {m.nameRu}
                </button>
                <div className="text-[10px] text-slate-400">
                  {STATUS_RU[m.status]} · {funded.toFixed(1)}% от {wcu(m.costWcuMinor)}
                  {m.status === "building" && ` · стройка ${Math.round(m.constructionProgress * 100)}%`}
                </div>
                <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full bg-violet-500" style={{ width: `${Math.min(100, funded)}%` }} />
                </div>
                <div className="text-[10px] text-slate-300">
                  {m.stakes.map((s) => `S${s.sectorId}: ${(s.share * 100).toFixed(1)}%`).join(" · ") || "Долей пока нет"}
                </div>
                {m.status === "operational" && (
                  <div className="text-[10px] text-emerald-300">
                    Дивиденды: {wcu(m.monthlyDividendWcuMinor)}/мес{my ? `, ваши ≈ ${formatMoney(BigInt(Math.round(Number(m.monthlyDividendWcuMinor) * my.share)))} МРЕ` : ""}
                  </div>
                )}
                {m.status === "funding" && (
                  <div className="space-y-1 pt-1">
                    {sourceToggle}
                    <div className="flex gap-1">
                      <input
                        type="number"
                        min={0}
                        step={1_000_000}
                        value={amount}
                        onChange={(e) => setAmount(Number(e.target.value))}
                        className="flex-1 px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 font-mono text-[11px]"
                      />
                      <button
                        onClick={() => onSendCommand({ type: "contribute_megaproject", sectorId: activeSectorId, buildingId: m.buildingId, amountUnits: amount, source })}
                        className="px-2 py-0.5 rounded bg-violet-700 hover:bg-violet-600 text-white"
                      >
                        Внести МРЕ
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === "exchange" && (
        <div className="space-y-1.5">
          {onOpenExchangeModal && (
            <button
              onClick={onOpenExchangeModal}
              className="w-full py-1.5 px-2 rounded bg-emerald-700 hover:bg-emerald-600 text-white font-semibold text-[11px]"
            >
              Открыть терминал Фондовой Биржи (SPO и поглощения)
            </button>
          )}
          {snapshot.exchange.length === 0 ? (
            <div className="text-[11px] text-slate-500">
              Нет котирующихся компаний. Биржевая площадка FIN-02 в секторе выводит его заводы на биржу.
            </div>
          ) : (
            <>
              <label className="flex items-center gap-2 text-[11px]">
                <span className="text-slate-400">Доля сделки</span>
                <input type="range" min={1} max={50} value={stakePct} onChange={(e) => setStakePct(Number(e.target.value))} className="flex-1" />
                <span className="font-mono w-8 text-right">{stakePct}%</span>
              </label>
              {sourceToggle}
              <ul className="space-y-1 max-h-72 overflow-y-auto">
                {snapshot.exchange.map((c) => {
                  const own = c.sectorId === activeSectorId;
                  const mine = own ? c.cityShare : c.foreignStakes.find((f) => f.sectorId === activeSectorId)?.share ?? 0;
                  const homeSym = snapshot.sectors.find((s) => s.sectorId === c.sectorId)?.currencySymbol ?? "";
                  const trade = (sign: 1 | -1) =>
                    onSendCommand({ type: "trade_stake", sectorId: activeSectorId, buildingId: c.buildingId, deltaShare: (sign * stakePct) / 100, source });
                  return (
                    <li key={c.buildingId} className="rounded border border-slate-800 bg-slate-900 p-1.5">
                      <div className="flex justify-between text-[11px]">
                        <span className="font-semibold">S{c.sectorId} · {c.nameRu} Ур.{c.level}</span>
                        <span className="font-mono text-slate-400">ROI {(c.annualRoi * 100).toFixed(1)}%</span>
                      </div>
                      <div className="text-[10px] text-slate-400">
                        1% = {homeSym} {formatMoney(BigInt(c.pricePerPercentLocalMinor))} · город {(c.cityShare * 100).toFixed(0)}% · частные{" "}
                        {(c.privateShare * 100).toFixed(0)}%
                        {c.foreignStakes.map((f) => ` · S${f.sectorId} ${(f.share * 100).toFixed(0)}%`).join("")}
                      </div>
                      <div className="flex gap-1 mt-1">
                        <button onClick={() => trade(1)} className="flex-1 px-1 py-0.5 rounded bg-emerald-800 hover:bg-emerald-700 text-[10px]">
                          {own ? "Выкупить у частных" : "Купить долю"}
                        </button>
                        <button
                          onClick={() => trade(-1)}
                          disabled={mine <= 0}
                          className="flex-1 px-1 py-0.5 rounded bg-rose-900 hover:bg-rose-800 text-[10px] disabled:opacity-40"
                        >
                          {own ? "Приватизировать" : "Продать долю"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}

      {tab === "energy" && (
        <div className="space-y-2 text-[11px]">
          <div>
            <div className="font-semibold text-slate-200 mb-0.5">Газ (магистральный трубопровод)</div>
            {gas && (gas.supplyKm3PerHour > 0 || gas.gasReadyPlants > 0 || gas.backupFuelOilBurned) ? (
              <div className="space-y-1">
                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                  <span className="text-slate-400">Добыча / спрос</span>
                  <span className="font-mono">{gas.supplyKm3PerHour} / {gas.demandKm3PerHour} тыс. м³/ч</span>
                  <span className="text-slate-400">Импорт / экспорт</span>
                  <span className="font-mono">{gas.importedKm3PerHour} / {gas.exportedKm3PerHour}</span>
                  <span className="text-slate-400">Газифицировано</span>
                  <span className="font-mono">
                    {gas.gasifiedPlants} из {gas.gasReadyPlants} заводов (+{Math.round(gas.avgOutputBoost * 100)}% выпуска)
                  </span>
                </div>
                {gas.backupFuelOilBurned && (
                  <div className="px-2 py-1 rounded bg-rose-950/70 border border-rose-600 text-rose-200 text-[10px]">
                    ⚠️ Дефицит газа в трубе: газовые ТЭС (ENG-02) перешли на резервный мазут (45% МВт, рост импорта топлива)!
                  </div>
                )}
              </div>
            ) : (
              <div className="text-slate-500 text-[10px]">Соедините газовую скважину EXT-07 или нефтеплатформу EXT-05 трубопроводом с заводами: +40% выпуска, −50% выбросов.</div>
            )}
            {onOpenKppModal && (
              <button
                onClick={onOpenKppModal}
                className="mt-1.5 w-full py-1 px-2 rounded bg-cyan-800 hover:bg-cyan-700 text-white text-[10px] font-medium"
              >
                Управление КПП и газовыми вентилями
              </button>
            )}
          </div>
          {ring && (
            <div>
              <div className="font-semibold text-slate-200 mb-0.5 flex items-center gap-1">
                <Zap className="w-3.5 h-3.5 text-yellow-300" /> Энергокольцо ЛЭП
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                <span className="text-slate-400">Генерация / спрос</span>
                <span className="font-mono">{ring.supplyMw} / {ring.demandMw} МВт</span>
                <span className="text-slate-400">Покупка / продажа</span>
                <span className="font-mono">{ring.importedMw} / {ring.exportedMw} МВт</span>
                <span className="text-slate-400">Соседи в кольце</span>
                <span>{ring.partners.length > 0 ? ring.partners.map((p) => `S${p}`).join(", ") : "нет — доведите ЛЭП до КПП"}</span>
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">Дефицит докупается у соседей с наценкой 20% — без веерных отключений.</div>
            </div>
          )}
        </div>
      )}

      {tab === "funds" && (
        <div className="space-y-1.5 text-[11px]">
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
            <span className="text-slate-400">Фонд благосостояния</span>
            <span className="font-mono">{wcu(sec.swfBalanceWcuMinor)}</span>
            <span className="text-slate-400">Стерилизация экспорта</span>
            <span className="font-mono">{Math.round(sec.swfSterilizationShare * 100)}%</span>
            <span className="text-slate-400">Кредитный рейтинг</span>
            <span className="font-mono">{sec.creditRating} (долг/доход {sec.debtToRevenue})</span>
            <span className="text-slate-400">Программа МВФ</span>
            <span className={sec.imfActive ? "text-amber-300" : "text-slate-300"}>
              {sec.imfActive
                ? `активна: ${sec.imfTranchesDisbursed ?? 0}/4 траншей, долг ${wcu(sec.imfDebtWcuMinor ?? "0")}`
                : "нет"}
            </span>
          </div>
          <div className="text-[10px] text-slate-500">
            Долю стерилизации (0–80%) задаёт ЦБ в «ЦБ и 5 Регионов». МРЕ из Фонда идут на мегапроекты и покупку акций соседей.
            МВФ подключается сам, когда резервов меньше чем на 2 месяца импорта или спред выше 5 п.п.: запрет печати денег,
            НДС +2 п.п., расходы −5%.
          </div>
        </div>
      )}
    </div>
  );
};
