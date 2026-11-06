import React, { useState } from "react";
import { Shield, X } from "lucide-react";
import {
  CARGO_LANES,
  LANE_NAMES_RU,
  VISA_NAMES_RU,
  formatMoney,
  type BorderSidePolicyDto,
  type CargoLaneId,
  type ClientCommand,
  type SectorId,
  type VisaRegimeId,
  type WorldSnapshotDto,
} from "@pentapolis/shared-sim";

interface BorderPostPanelProps {
  snapshot: WorldSnapshotDto;
  postId: string;
  activeSectorId: SectorId;
  onSendCommand: (cmd: ClientCommand) => void;
  onClose: () => void;
}

const VISAS: readonly VisaRegimeId[] = ["visa_free", "paid_visa", "skilled_quota", "closed"];
const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Border post context menu (Sprint 7, GDD §5.3): each mayor runs their own side — visa regime,
 * duty per cargo lane, embargoes and inspection. Hostile moves wait for the notice window.
 */
export const BorderPostPanel: React.FC<BorderPostPanelProps> = ({ snapshot, postId, activeSectorId, onSendCommand, onClose }) => {
  const post = snapshot.borderPosts.find((p) => p.id === postId);
  const stats = snapshot.borderStats.find((s) => s.postId === postId);
  const mine = post?.sides.find((s) => s.sectorId === activeSectorId);
  const [draft, setDraft] = useState<BorderSidePolicyDto | null>(mine ?? null);
  if (!post) return null;
  const neighbor = post.sectorA === activeSectorId ? post.sectorB : post.sectorA;
  const theirs = post.sides.find((s) => s.sectorId === neighbor);
  const sym = (s: SectorId) => snapshot.sectors.find((x) => x.sectorId === s)?.currencySymbol ?? "";
  const editable = mine && draft;

  const send = () => {
    if (!draft) return;
    onSendCommand({
      type: "set_border_policy",
      sectorId: activeSectorId,
      postId,
      visaRegime: draft.visaRegime,
      importDuty: { ...draft.importDuty },
      exportDuty: { ...draft.exportDuty },
      embargo: [...draft.embargo],
      inspection: draft.inspection,
    });
  };
  const setDuty = (lane: CargoLaneId, kind: "importDuty" | "exportDuty", value: number) =>
    draft && setDraft({ ...draft, [kind]: { ...draft[kind], [lane]: value } });
  const toggleEmbargo = (lane: CargoLaneId) =>
    draft && setDraft({ ...draft, embargo: draft.embargo.includes(lane) ? draft.embargo.filter((l) => l !== lane) : [...draft.embargo, lane] });

  return (
    <div className="rounded-xl bg-slate-950/95 backdrop-blur-md border border-cyan-700/60 shadow-2xl p-3 text-xs space-y-2.5">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-1.5 font-bold text-cyan-300">
          <Shield className="w-4 h-4" />
          <span>КПП #{post.id}: S{post.sectorA} ↔ S{post.sectorB}</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Закрыть">
          <X className="w-4 h-4" />
        </button>
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
          <span className="text-slate-400">Дороги подведены</span>
          <span className={stats.roadLinked ? "text-emerald-300" : "text-rose-300"}>{stats.roadLinked ? "с обеих сторон" : "нет — подведите улицы к КПП"}</span>
          <span className="text-slate-400">Фуры / пропускная</span>
          <span className="font-mono">{stats.trucksPerHour} / {stats.capacityTrucksPerHour} в час</span>
          <span className="text-slate-400">Очередь</span>
          <span className={`font-mono ${stats.queueMinutes >= 120 ? "text-rose-400" : ""}`}>{stats.queueMinutes} мин</span>
          <span className="text-slate-400">Пересекают границу</span>
          <span className="font-mono">{stats.crossersPerMonth.toLocaleString("ru-RU")} чел./мес</span>
          {stats.revenue.map((r) => (
            <React.Fragment key={r.sectorId}>
              <span className="text-slate-400">Доход S{r.sectorId} в месяц</span>
              <span className="font-mono">
                {sym(r.sectorId)} {formatMoney(BigInt(r.dutyMinor) + BigInt(r.visaMinor))}
                {r.smuggledValueMinor !== "0" && <span className="text-rose-300"> (контрабанда {formatMoney(BigInt(r.smuggledValueMinor))})</span>}
              </span>
            </React.Fragment>
          ))}
        </div>
      )}
      {stats && stats.flows.length > 0 && (
        <ul className="text-[10px] text-slate-300 space-y-0.5">
          {stats.flows.map((f, i) => (
            <li key={i}>S{f.fromSector} → S{f.toSector}: {f.commodity} · {f.trucksPerHour} фур/ч</li>
          ))}
        </ul>
      )}

      {post.pending.map((p) => (
        <div key={p.sectorId} className="px-2 py-1 rounded border border-amber-500/60 bg-amber-950/40 text-amber-100 text-[10px]">
          ⏳ {p.descriptionRu}
        </div>
      ))}

      {theirs && (
        <div className="text-[10px] text-slate-400">
          Сторона S{neighbor}: {VISA_NAMES_RU[theirs.visaRegime]}
          {theirs.embargo.length > 0 && `, эмбарго: ${theirs.embargo.map((l) => LANE_NAMES_RU[l].split(" ")[0]).join(", ")}`}
          {theirs.inspection === "strict" && ", жёсткий досмотр"}
        </div>
      )}

      {editable ? (
        <div className="space-y-2 border-t border-slate-800 pt-2">
          <div className="font-semibold text-[11px] text-slate-200">Ваша сторона (S{activeSectorId})</div>
          <div className="grid grid-cols-2 gap-1">
            {VISAS.map((v) => (
              <button
                key={v}
                onClick={() => setDraft({ ...draft, visaRegime: v })}
                className={`px-1.5 py-1 rounded border text-[10px] ${draft.visaRegime === v ? "bg-cyan-700 border-cyan-400 text-white" : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}
              >
                {VISA_NAMES_RU[v]}
              </button>
            ))}
          </div>
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-slate-500">
                <th className="text-left font-normal">Груз</th>
                <th className="font-normal">Ввоз</th>
                <th className="font-normal">Вывоз</th>
                <th className="font-normal">Эмбарго</th>
              </tr>
            </thead>
            <tbody>
              {CARGO_LANES.map((lane) => (
                <tr key={lane}>
                  <td className="pr-1">{LANE_NAMES_RU[lane].split(" (")[0]}</td>
                  {(["importDuty", "exportDuty"] as const).map((kind) => (
                    <td key={kind} className="px-0.5">
                      <input
                        type="number"
                        min={0}
                        max={200}
                        step={1}
                        value={Math.round(draft[kind][lane] * 100)}
                        onChange={(e) => setDuty(lane, kind, Number(e.target.value) / 100)}
                        className={`w-12 px-1 rounded bg-slate-900 border text-right font-mono ${kind === "importDuty" && draft.importDuty[lane] > 0.5 ? "border-amber-500" : "border-slate-700"}`}
                      />
                    </td>
                  ))}
                  <td className="text-center">
                    <input type="checkbox" checked={draft.embargo.includes(lane)} onChange={() => toggleEmbargo(lane)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <label className="flex items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={draft.inspection === "strict"}
              onChange={() => setDraft({ ...draft, inspection: draft.inspection === "strict" ? "green" : "strict" })}
            />
            Жёсткий досмотр (контрабанда ×0.5, пропускная ×0.5)
          </label>
          <div className="text-[10px] text-slate-500">
            Пошлина выше 50%, эмбарго и закрытие границы вступают в силу через 3–6 игровых дней (окно уведомления соседа).
            Заградительные пошлины уводят в контрабанду до {pct(0.41)} потока — казна с неё ничего не получает.
          </div>
          <button onClick={send} className="w-full px-2 py-1.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white font-semibold">
            Применить режим КПП
          </button>
        </div>
      ) : (
        <div className="text-[10px] text-slate-500">Этот КПП на границе секторов S{post.sectorA} и S{post.sectorB} — управлять могут только их мэры.</div>
      )}
    </div>
  );
};
