import React, { useState } from "react";
import { Check, Crown, Globe2, Ship, Waves, X } from "lucide-react";
import {
  NATIONAL_CURRENCIES,
  type CurrencyCode,
  type SectorId,
  type SectorProfileSpec,
  type WorldSnapshotDto,
} from "@pentapolis/shared-sim";

interface RegionSelectModalProps {
  snapshot: WorldSnapshotDto;
  sectorProfiles: readonly SectorProfileSpec[];
  activeSectorId: SectorId;
  onClose: () => void;
  onSelectActiveSector: (sectorId: SectorId) => void;
  onClaimSector: (
    sectorId: SectorId,
    cityName: string,
    mayorName: string,
    currency: CurrencyCode
  ) => void;
}

export const RegionSelectModal: React.FC<RegionSelectModalProps> = ({
  snapshot,
  sectorProfiles,
  activeSectorId,
  onClose,
  onSelectActiveSector,
  onClaimSector,
}) => {
  const [selectedSlot, setSelectedSlot] = useState<SectorId>(activeSectorId);
  const currentDto = snapshot.sectors.find((s) => s.sectorId === selectedSlot)!;
  const currentProfile = sectorProfiles.find((p) => p.sectorId === selectedSlot);

  const [cityName, setCityName] = useState(
    currentDto.occupied ? currentDto.cityName : `Пентаград-${selectedSlot}`
  );
  const [mayorName, setMayorName] = useState(
    currentDto.occupied ? currentDto.mayorName : "Мэр-Основатель"
  );
  const [currency, setCurrency] = useState<CurrencyCode>(currentDto.currency);

  const takenByOtherMayors = new Set<CurrencyCode>(
    snapshot.sectors
      .filter((s) => s.occupied && s.sectorId !== selectedSlot)
      .map((s) => s.currency)
  );
  const otherOccupiedCount = snapshot.sectors.filter(
    (s) => s.occupied && s.sectorId !== selectedSlot
  ).length;
  const uahRequiredNow = otherOccupiedCount === 4 && !takenByOtherMayors.has("UAH");

  const handlePickSlot = (sId: SectorId) => {
    setSelectedSlot(sId);
    const dto = snapshot.sectors.find((s) => s.sectorId === sId)!;
    setCityName(dto.occupied ? dto.cityName : `Пентаград-${sId}`);
    setMayorName(dto.occupied ? dto.mayorName : "Мэр-Основатель");
    if (!takenByOtherMayors.has(dto.currency)) {
      setCurrency(dto.currency);
    }
  };

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-5xl max-h-[90vh] flex flex-col rounded-xl bg-slate-900 border border-slate-700 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 bg-slate-950 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <Globe2 className="w-5 h-5 text-amber-400" />
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                Выбор Региона и Национальной Валюты Пентаполиса
              </h2>
              <p className="text-[11px] text-slate-400">
                5 суверенных секторов (~90 000 тайлов суши каждый) вокруг Центрального Ядра · Гривна (₴ UAH) обязательна в каждом сезоне
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body: 5 Sector Cards + Claim Form */}
        <div className="grid grid-cols-12 gap-4 p-4 overflow-y-auto">
          {/* Left 7 cols: 5 Asymmetric Sectors */}
          <div className="col-span-12 lg:col-span-7 space-y-2">
            {sectorProfiles.map((prof) => {
              const dto = snapshot.sectors.find((s) => s.sectorId === prof.sectorId)!;
              const isSelected = prof.sectorId === selectedSlot;
              return (
                <div
                  key={prof.sectorId}
                  onClick={() => handlePickSlot(prof.sectorId)}
                  className={`cursor-pointer rounded-lg p-3 border transition ${
                    isSelected
                      ? "bg-sky-950/60 border-sky-400 shadow-md"
                      : "bg-slate-950/60 border-slate-800 hover:border-slate-600"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/40 text-amber-300 font-bold text-xs">
                        S{prof.sectorId}
                      </span>
                      <span className="font-bold text-sm text-white">{prof.nameRu}</span>
                      <span className="text-xs text-slate-400">({dto.currencySymbol} {dto.currency})</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                          dto.occupied
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                            : "bg-slate-800 text-slate-300"
                        }`}
                      >
                        {dto.occupied ? `Мэр: ${dto.mayorName}` : "Свободный слот ($10M)"}
                      </span>
                      <span className="text-[11px] text-amber-300 font-mono flex items-center gap-1">
                        <Crown className="w-3 h-3" /> {dto.hegemony.totalPoints} очк.
                      </span>
                    </div>
                  </div>

                  <p className="mt-1 text-xs text-sky-200">{prof.profileSummaryRu}</p>

                  <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                    <span>Вход: {prof.gatewayLabelRu}</span>
                    <span className="flex items-center gap-1">
                      <Ship className="w-3 h-3 text-sky-400" /> Осадка порта до {prof.maxPortDraftMeters} м
                    </span>
                    {prof.hasHydroPotential && (
                      <span className="flex items-center gap-1 text-cyan-300">
                        <Waves className="w-3 h-3" /> Потенциал каскада ГЭС
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right 5 cols: Sovereign Charter & Currency Picker */}
          <div className="col-span-12 lg:col-span-5 flex flex-col justify-between rounded-lg bg-slate-950 p-4 border border-slate-800">
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <div>
                  <h3 className="text-sm font-bold text-amber-300">
                    Хартия Сектора S{selectedSlot}: {currentProfile?.nameRu}
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Соседи по кольцу: {currentProfile?.neighborSectors.map((n) => `S${n}`).join(", ")}
                  </p>
                </div>
                <button
                  onClick={() => {
                    onSelectActiveSector(selectedSlot);
                    onClose();
                  }}
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs text-sky-300 border border-slate-700"
                >
                  Перейти камерой
                </button>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Название города</label>
                <input
                  type="text"
                  value={cityName}
                  onChange={(e) => setCityName(e.target.value)}
                  className="w-full px-3 py-1.5 rounded bg-slate-900 border border-slate-700 text-sm text-white focus:border-sky-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Имя Мэра</label>
                <input
                  type="text"
                  value={mayorName}
                  onChange={(e) => setMayorName(e.target.value)}
                  className="w-full px-3 py-1.5 rounded bg-slate-900 border border-slate-700 text-sm text-white focus:border-sky-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Суверенная валюта региона (16 канонических валют, курс от 1.00 к МРЕ)
                </label>
                {uahRequiredNow && (
                  <p className="mb-1.5 text-[11px] text-amber-300 bg-amber-950/50 border border-amber-500/40 rounded px-2 py-1">
                    4 сектора заняты без Гривны — для 5-го сектора обязательна Гривна (₴ UAH)!
                  </p>
                )}
                <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto pr-1">
                  {NATIONAL_CURRENCIES.map((cur) => {
                    const cCode = cur.code as CurrencyCode;
                    const disabled =
                      takenByOtherMayors.has(cCode) || (uahRequiredNow && cCode !== "UAH");
                    const active = currency === cCode;
                    return (
                      <button
                        key={cur.code}
                        type="button"
                        disabled={disabled}
                        onClick={() => setCurrency(cCode)}
                        className={`flex items-center justify-between px-2.5 py-1.5 rounded text-xs border transition ${
                          disabled
                            ? "opacity-35 cursor-not-allowed bg-slate-900 border-slate-800 text-slate-500"
                            : active
                              ? "bg-amber-500/20 border-amber-400 text-amber-200 font-semibold"
                              : "bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-200"
                        }`}
                      >
                        <span>
                          <strong className="mr-1 text-amber-300">{cur.symbol}</strong>
                          {cur.nameRu} ({cur.code})
                        </span>
                        {cur.mandatoryInSeason && (
                          <span className="text-[9px] px-1 rounded bg-sky-500/20 text-sky-300">
                            Обяз.
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="pt-3 mt-3 border-t border-slate-800 flex items-center justify-end gap-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-300"
              >
                Закрыть
              </button>
              <button
                onClick={() => {
                  onClaimSector(selectedSlot, cityName, mayorName, currency);
                  onSelectActiveSector(selectedSlot);
                  onClose();
                }}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white shadow-lg transition"
              >
                <Check className="w-4 h-4" />
                <span>Возглавить Сектор S{selectedSlot}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
