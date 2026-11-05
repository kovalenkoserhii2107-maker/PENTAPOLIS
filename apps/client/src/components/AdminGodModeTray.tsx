import React, { useState } from "react";
import { FastForward, Flame, RotateCcw, ShieldAlert, X } from "lucide-react";
import {
  CANONICAL_EMERGENCIES,
  type EmergencyId,
  type SectorId,
} from "@pentapolis/shared-sim";

interface AdminGodModeTrayProps {
  activeSectorId: SectorId;
  onClose: () => void;
  onSwitchSector: (sectorId: SectorId) => void;
  onTimeSkip: (jump: "1h" | "1d" | "1mo" | "1yr") => void;
  onResetSector: (sectorId: SectorId) => void;
  onTriggerEmergency: (sectorId: SectorId, emergencyId: EmergencyId) => void;
}

export const AdminGodModeTray: React.FC<AdminGodModeTrayProps> = ({
  activeSectorId,
  onClose,
  onSwitchSector,
  onTimeSkip,
  onResetSector,
  onTriggerEmergency,
}) => {
  const [selectedEmg, setSelectedEmg] = useState<EmergencyId>("FIRE");

  return (
    <div className="pointer-events-auto fixed right-3 top-14 z-40 w-80 rounded-xl bg-slate-950/95 backdrop-blur-md border border-purple-500/60 shadow-2xl p-3 text-xs space-y-3">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-1.5 font-bold text-purple-300">
          <ShieldAlert className="w-4 h-4 text-purple-400" />
          <span>Бог-Режим / Админ-панель (`~`)</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Instant Time Skips */}
      <div className="space-y-1.5">
        <div className="text-[11px] text-slate-400 flex items-center gap-1">
          <FastForward className="w-3.5 h-3.5 text-purple-400" />
          <span>Мгновенная перемотка макро-времени:</span>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {(
            [
              ["1h", "+1 час"],
              ["1d", "+1 день"],
              ["1mo", "+1 мес"],
              ["1yr", "+1 год"],
            ] as const
          ).map(([jump, label]) => (
            <button
              key={jump}
              onClick={() => onTimeSkip(jump)}
              className="px-2 py-1.5 rounded bg-purple-900/60 hover:bg-purple-700 border border-purple-500/40 text-purple-100 font-semibold transition"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Instant Sector Control Switch */}
      <div className="space-y-1.5">
        <div className="text-[11px] text-slate-400">Переключение управления сектором:</div>
        <div className="flex gap-1">
          {([1, 2, 3, 4, 5] as const).map((sId) => (
            <button
              key={sId}
              onClick={() => onSwitchSector(sId)}
              className={`flex-1 py-1 rounded font-bold ${
                activeSectorId === sId
                  ? "bg-amber-500 text-slate-950"
                  : "bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800"
              }`}
            >
              S{sId}
            </button>
          ))}
        </div>
      </div>

      {/* Trigger Live Urban Emergency */}
      <div className="space-y-1.5">
        <div className="text-[11px] text-slate-400 flex items-center gap-1">
          <Flame className="w-3.5 h-3.5 text-rose-400" />
          <span>Тест 12 городских ЧП в S{activeSectorId}:</span>
        </div>
        <select
          value={selectedEmg}
          onChange={(e) => setSelectedEmg(e.target.value as EmergencyId)}
          className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-white"
        >
          {CANONICAL_EMERGENCIES.map((emg) => (
            <option key={emg.id} value={emg.id}>
              {emg.index}. {emg.nameRu}
            </option>
          ))}
        </select>
        <button
          onClick={() => onTriggerEmergency(activeSectorId, selectedEmg)}
          className="w-full py-1.5 rounded bg-rose-700 hover:bg-rose-600 text-white font-semibold transition"
        >
          Запустить ЧП в S{activeSectorId}
        </button>
      </div>

      {/* Reset Sector */}
      <div className="pt-2 border-t border-slate-800">
        <button
          onClick={() => onResetSector(activeSectorId)}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded bg-slate-900 hover:bg-rose-950 border border-slate-700 text-rose-300 transition"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Сбросить Сектор S{activeSectorId} до чистого листа ($10M)</span>
        </button>
      </div>
    </div>
  );
};
