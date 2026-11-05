import React, { useState } from "react";
import { AlertTriangle, Crown, Landmark, Scale, Table2, X } from "lucide-react";
import {
  CANONICAL_DECREES,
  MATRIX_COLUMNS,
  formatMoney,
  type ClientCommand,
  type SectorId,
  type WorldSnapshotDto,
} from "@pentapolis/shared-sim";

interface MacroDashboardModalProps {
  snapshot: WorldSnapshotDto;
  activeSectorId: SectorId;
  onClose: () => void;
  onSendCommand: (cmd: ClientCommand) => void;
}

export const MacroDashboardModal: React.FC<MacroDashboardModalProps> = ({
  snapshot,
  activeSectorId,
  onClose,
  onSendCommand,
}) => {
  const [tab, setTab] = useState<"comparison" | "levers" | "matrix">("comparison");
  const [matrixSector, setMatrixSector] = useState<SectorId>(activeSectorId);

  const mySec =
    snapshot.sectors.find((s) => s.sectorId === activeSectorId) ?? snapshot.sectors[0]!;
  const inspectedSec =
    snapshot.sectors.find((s) => s.sectorId === matrixSector) ?? snapshot.sectors[0]!;

  const [pendingTariff, setPendingTariff] = useState<number>(mySec.importDutyRate);

  const updatePolicy = (
    patch: Omit<Extract<ClientCommand, { type: "update_policy" }>, "type" | "sectorId">
  ) => {
    onSendCommand({
      type: "update_policy",
      sectorId: activeSectorId,
      ...patch,
    });
  };

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-6xl max-h-[90vh] flex flex-col rounded-xl bg-slate-900 border border-slate-700 shadow-2xl overflow-hidden">
        {/* Header & Tabs */}
        <div className="flex items-center justify-between px-5 py-3 bg-slate-950 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <Landmark className="w-5 h-5 text-sky-400" />
            <h2 className="text-sm font-bold text-white uppercase tracking-wide">
              Макроэкономика, Центральный Банк и Двойная Запись Полуострова
            </h2>
            <div className="flex items-center gap-1 ml-3 bg-slate-900 p-1 rounded-lg border border-slate-800 text-xs">
              <button
                onClick={() => setTab("comparison")}
                className={`flex items-center gap-1 px-2.5 py-1 rounded ${
                  tab === "comparison" ? "bg-sky-600 text-white font-semibold" : "text-slate-300"
                }`}
              >
                <Crown className="w-3.5 h-3.5" />
                <span>5 Регионов и Гегемония</span>
              </button>
              <button
                onClick={() => setTab("levers")}
                className={`flex items-center gap-1 px-2.5 py-1 rounded ${
                  tab === "levers" ? "bg-sky-600 text-white font-semibold" : "text-slate-300"
                }`}
              >
                <Scale className="w-3.5 h-3.5" />
                <span>Рычаги S{activeSectorId} и ЦБ</span>
              </button>
              <button
                onClick={() => setTab("matrix")}
                className={`flex items-center gap-1 px-2.5 py-1 rounded ${
                  tab === "matrix" ? "bg-sky-600 text-white font-semibold" : "text-slate-300"
                }`}
              >
                <Table2 className="w-3.5 h-3.5" />
                <span>Матрица 7 Колонок (0.00 diff)</span>
              </button>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto text-xs space-y-4">
          {tab === "comparison" && (
            <div className="space-y-3">
              <p className="text-slate-300">
                Публичное табло всех 5 суверенных экономик полуострова (все курсы свободно плавают к{" "}
                <strong>МРЕ</strong>; обязательна <strong>Гривна ₴ UAH</strong>). Сезонный Индекс Гегемонии: максимум 1000 очков (300 Финансы + 250 Процветание + 250 Транзит + 200 Технологии).
              </p>
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full text-left border-collapse">
                  <thead className="bg-slate-950 text-slate-400 text-[11px] uppercase">
                    <tr>
                      <th className="p-2.5">Сектор / Город</th>
                      <th className="p-2.5">Валюта и Курс</th>
                      <th className="p-2.5">ВВП (МРЕ/мес)</th>
                      <th className="p-2.5">Инфляция</th>
                      <th className="p-2.5">Ставка ЦБ</th>
                      <th className="p-2.5">Рейтинг / МВФ</th>
                      <th className="p-2.5">Семьи / Счастье</th>
                      <th className="p-2.5">SWF Фонд</th>
                      <th className="p-2.5 text-right">Гегемония</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 bg-slate-900/70">
                    {snapshot.sectors.map((s) => (
                      <tr
                        key={s.sectorId}
                        className={
                          s.sectorId === activeSectorId ? "bg-sky-950/35" : "hover:bg-slate-800/50"
                        }
                      >
                        <td className="p-2.5 font-semibold text-white">
                          S{s.sectorId}: {s.cityName}
                          <div className="text-[10px] text-slate-400 font-normal">
                            {s.mayorName} · Этап {s.stage}
                          </div>
                        </td>
                        <td className="p-2.5 font-mono text-amber-300">
                          {s.currencySymbol} {s.currency}
                          <div className="text-[10px] text-sky-300">
                            {s.fxRatePerWcu.toFixed(3)} / МРЕ
                          </div>
                        </td>
                        <td className="p-2.5 font-mono text-emerald-300">
                          {s.gdpWcu.toLocaleString("ru-RU")}
                        </td>
                        <td
                          className={`p-2.5 font-mono ${
                            s.annualInflation > 0.08 ? "text-rose-400 font-bold" : "text-slate-200"
                          }`}
                        >
                          {(s.annualInflation * 100).toFixed(1)}%
                        </td>
                        <td className="p-2.5 font-mono text-slate-200">
                          {(s.keyRate * 100).toFixed(1)}%
                        </td>
                        <td className="p-2.5">
                          <span className="px-1.5 py-0.5 rounded bg-slate-800 font-mono text-slate-200">
                            {s.creditRating} ({s.debtToRevenue.toFixed(2)}x)
                          </span>
                          {s.imfActive && (
                            <span className="ml-1 px-1.5 py-0.5 rounded bg-rose-900/70 text-rose-200 text-[10px]">
                              МВФ
                            </span>
                          )}
                        </td>
                        <td className="p-2.5 text-slate-200">
                          {s.households.toLocaleString("ru-RU")} · H {s.happinessIndex.toFixed(0)}
                        </td>
                        <td className="p-2.5 font-mono text-cyan-300">
                          {formatMoney(BigInt(s.swfBalanceWcuMinor))} МРЕ
                        </td>
                        <td className="p-2.5 text-right font-mono font-bold text-amber-300">
                          {s.hegemony.totalPoints}
                          <div className="text-[10px] text-slate-400 font-normal">
                            {s.hegemony.financialAndIndustrial}/{s.hegemony.citizenProsperityAndLand}/
                            {s.hegemony.logisticsAndTransit}/{s.hegemony.techLeadership}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "levers" && (
            <div className="grid grid-cols-12 gap-4">
              {/* Monetary & Fiscal Sliders */}
              <div className="col-span-12 lg:col-span-7 space-y-3 bg-slate-950 p-4 rounded-lg border border-slate-800">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <span className="font-bold text-amber-300 text-sm">
                    Центральный Банк и Фискальная политика S{activeSectorId} ({mySec.currencySymbol})
                  </span>
                  <div className="flex gap-1">
                    {(
                      [
                        ["taylor", "Советник Тейлора"],
                        ["hawk", "Ястреб ЦБ"],
                        ["populist", "Популист (Печать)"],
                      ] as const
                    ).map(([preset, title]) => (
                      <button
                        key={preset}
                        onClick={() => updatePolicy({ preset })}
                        className="px-2 py-1 rounded bg-slate-800 hover:bg-sky-700 text-[11px] text-slate-200 transition"
                      >
                        {title}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block bg-slate-900 p-2.5 rounded border border-slate-800">
                    <div className="flex justify-between mb-1">
                      <span>Ключевая ставка ЦБ</span>
                      <strong className="text-sky-300">{(mySec.keyRate * 100).toFixed(1)}%</strong>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={35}
                      step={0.5}
                      value={mySec.keyRate * 100}
                      onChange={(e) => updatePolicy({ keyRate: Number(e.target.value) / 100 })}
                      className="w-full"
                    />
                  </label>

                  <label className="block bg-slate-900 p-2.5 rounded border border-slate-800">
                    <div className="flex justify-between mb-1">
                      <span>Норма резервов банков</span>
                      <strong className="text-sky-300">
                        {(mySec.reserveRequirement * 100).toFixed(0)}%
                      </strong>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={20}
                      step={1}
                      value={mySec.reserveRequirement * 100}
                      onChange={(e) =>
                        updatePolicy({ reserveRequirement: Number(e.target.value) / 100 })
                      }
                      className="w-full"
                    />
                  </label>

                  <label className="block bg-slate-900 p-2.5 rounded border border-slate-800">
                    <div className="flex justify-between mb-1">
                      <span>Печать денег (выкуп бондов ЦБ)</span>
                      <strong className="text-rose-300">
                        {(mySec.cbBondPurchaseShare * 100).toFixed(0)}%
                      </strong>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={mySec.cbBondPurchaseShare * 100}
                      onChange={(e) =>
                        updatePolicy({ cbBondPurchaseShare: Number(e.target.value) / 100 })
                      }
                      className="w-full"
                    />
                  </label>

                  <label className="block bg-slate-900 p-2.5 rounded border border-slate-800">
                    <div className="flex justify-between mb-1">
                      <span>Стерилизация в SWF (МРЕ)</span>
                      <strong className="text-cyan-300">
                        {(mySec.swfSterilizationShare * 100).toFixed(0)}%
                      </strong>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={80}
                      step={5}
                      value={mySec.swfSterilizationShare * 100}
                      onChange={(e) =>
                        updatePolicy({ swfSterilizationShare: Number(e.target.value) / 100 })
                      }
                      className="w-full"
                    />
                  </label>

                  <label className="block bg-slate-900 p-2.5 rounded border border-slate-800">
                    <div className="flex justify-between mb-1">
                      <span>НДС (VAT)</span>
                      <strong className="text-amber-300">
                        {(mySec.vatRate * 100).toFixed(0)}%
                      </strong>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={25}
                      step={1}
                      value={mySec.vatRate * 100}
                      onChange={(e) => updatePolicy({ vatRate: Number(e.target.value) / 100 })}
                      className="w-full"
                    />
                  </label>

                  <label className="block bg-slate-900 p-2.5 rounded border border-slate-800">
                    <div className="flex justify-between mb-1">
                      <span>Налог на прибыль (влияет на 90%)</span>
                      <strong className="text-amber-300">
                        {(mySec.corpTaxRate * 100).toFixed(0)}%
                      </strong>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={40}
                      step={1}
                      value={mySec.corpTaxRate * 100}
                      onChange={(e) => updatePolicy({ corpTaxRate: Number(e.target.value) / 100 })}
                      className="w-full"
                    />
                  </label>
                </div>

                {/* Import Duty with Notice Window > 50% */}
                <div className="bg-slate-900 p-3 rounded border border-slate-800 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span>
                      Ввозная таможенная пошлина (действующая:{" "}
                      <strong>{(mySec.importDutyRate * 100).toFixed(0)}%</strong>)
                    </span>
                    <button
                      onClick={() => updatePolicy({ importDutyRate: pendingTariff })}
                      className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold text-[11px]"
                    >
                      Применить {Math.round(pendingTariff * 100)}%
                    </button>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={2}
                    value={pendingTariff * 100}
                    onChange={(e) => setPendingTariff(Number(e.target.value) / 100)}
                    className="w-full"
                  />
                  {pendingTariff > 0.5 && (
                    <div className="flex items-center gap-1.5 text-[11px] text-amber-300">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        Пошлина свыше 50% запускает Окно уведомления (3–6 игровых дней до вступления в силу) и усиливает контрабанду!
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* 8 City Decrees */}
              <div className="col-span-12 lg:col-span-5 bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-2">
                <div className="font-bold text-sky-300 text-sm border-b border-slate-800 pb-2">
                  8 Городских Указов Мэрии
                </div>
                <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
                  {CANONICAL_DECREES.map((dec) => {
                    const active = mySec.activeDecreeIds.includes(dec.id);
                    return (
                      <div
                        key={dec.id}
                        onClick={() => updatePolicy({ toggleDecreeId: dec.id })}
                        className={`cursor-pointer p-2.5 rounded border transition ${
                          active
                            ? "bg-emerald-950/50 border-emerald-500 text-white"
                            : "bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-300"
                        }`}
                      >
                        <div className="flex items-center justify-between font-semibold">
                          <span>{dec.nameRu}</span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] ${
                              active ? "bg-emerald-600 text-white" : "bg-slate-800 text-slate-400"
                            }`}
                          >
                            {active ? "АКТИВЕН" : "ВЫКЛ"}
                          </span>
                        </div>
                        <div className="text-[10px] text-emerald-300 mt-0.5">
                          + {dec.effectSummary}
                        </div>
                        <div className="text-[10px] text-slate-400">− {dec.sideEffectSummary}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {tab === "matrix" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-400">Регион аудита:</span>
                  {([1, 2, 3, 4, 5] as const).map((sId) => (
                    <button
                      key={sId}
                      onClick={() => setMatrixSector(sId)}
                      className={`px-2.5 py-1 rounded font-semibold ${
                        matrixSector === sId
                          ? "bg-amber-500 text-slate-950"
                          : "bg-slate-800 text-slate-300"
                      }`}
                    >
                      S{sId} ({snapshot.sectors[sId - 1]?.currencySymbol})
                    </button>
                  ))}
                </div>
                <div className="font-mono text-emerald-400 bg-emerald-950/50 px-3 py-1 rounded border border-emerald-600/40">
                  Статус 4 инвариантов:{" "}
                  {inspectedSec.invariantValid
                    ? `OK (макс. расхождение = ${inspectedSec.maxErrorMinor} коп.)`
                    : "НАРУШЕН"}
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full text-right border-collapse font-mono text-[11px]">
                  <thead className="bg-slate-950 text-slate-400">
                    <tr>
                      <th className="p-2 text-left">Поток (в {inspectedSec.currencySymbol})</th>
                      {MATRIX_COLUMNS.map((col) => (
                        <th key={col} className="p-2">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80 bg-slate-900/70">
                    {inspectedSec.lastMatrix.map((row) => (
                      <tr key={row.label} className="hover:bg-slate-800/50">
                        <td className="p-1.5 text-left font-sans text-slate-200">{row.label}</td>
                        {row.cellsMinor.map((minorStr, idx) => {
                          const val = BigInt(minorStr);
                          return (
                            <td
                              key={idx}
                              className={`p-1.5 ${
                                val > 0n
                                  ? "text-emerald-300"
                                  : val < 0n
                                    ? "text-rose-300"
                                    : "text-slate-600"
                              }`}
                            >
                              {val === 0n ? "—" : formatMoney(val)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
