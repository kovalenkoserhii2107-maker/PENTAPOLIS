import React, { useEffect, useState } from "react";
import { ArrowLeft, Bus, Crosshair, Home, MapPin, Truck, User, X } from "lucide-react";
import {
  formatMoney,
  type CitizenDossierDto,
  type VehicleInspectorDto,
} from "@pentapolis/shared-sim";

interface AgentInspectorPanelProps {
  vehicleId: string;
  following: boolean;
  onClose: () => void;
  onToggleFollow: () => void;
  onFocusTile: (tileX: number, tileY: number) => void;
}

const ROLE_LABELS: Readonly<Record<VehicleInspectorDto["role"], string>> = {
  commuter: "Личный транспорт",
  freight: "Грузовой рейс",
  bus: "Городской автобус (лицензия)",
  metro: "Поезд метро",
  service: "Городская служба — выезд на ЧП",
};

function money(symbol: string, minor: string): string {
  return `${symbol} ${formatMoney(BigInt(minor))}`;
}

function healthTone(health: number): string {
  if (health < 40) return "text-rose-400";
  if (health < 75) return "text-amber-300";
  return "text-emerald-300";
}

/**
 * Two-layer Agent Inspector (GDD §7, sheet 24 Table 2): click a vehicle for its card, then follow
 * the driver link to the citizen dossier with a kopiyka-exact monthly household ledger.
 */
export const AgentInspectorPanel: React.FC<AgentInspectorPanelProps> = ({
  vehicleId,
  following,
  onClose,
  onToggleFollow,
  onFocusTile,
}) => {
  const [vehicle, setVehicle] = useState<VehicleInspectorDto | null>(null);
  const [citizenId, setCitizenId] = useState<string | null>(null);
  const [citizen, setCitizen] = useState<CitizenDossierDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCitizenId(null);
    setCitizen(null);
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/vehicle/${encodeURIComponent(vehicleId)}`);
        const data = (await res.json()) as VehicleInspectorDto & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? "Транспорт не найден");
          return;
        }
        setError(null);
        setVehicle(data);
      } catch {
        if (!cancelled) setError("Нет связи с сервером");
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [vehicleId]);

  useEffect(() => {
    if (!citizenId) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/citizen/${encodeURIComponent(citizenId)}`);
      if (cancelled) return;
      if (res.ok) setCitizen((await res.json()) as CitizenDossierDto);
      else setError("Досье недоступно: водитель сменился на тактическом тике");
    })();
    return () => {
      cancelled = true;
    };
  }, [citizenId]);

  const header = (title: React.ReactNode) => (
    <div className="flex items-center justify-between border-b border-slate-800 pb-2">
      <div className="flex items-center gap-1.5 font-bold text-sky-300 min-w-0">{title}</div>
      <button onClick={onClose} className="text-slate-400 hover:text-white shrink-0" aria-label="Закрыть">
        <X className="w-4 h-4" />
      </button>
    </div>
  );

  if (error && !vehicle) {
    return (
      <div className="rounded-xl bg-slate-950/95 border border-slate-700 p-3 text-xs space-y-2">
        {header(<span>Инспектор транспорта</span>)}
        <p className="text-rose-300">{error}</p>
      </div>
    );
  }
  if (!vehicle) {
    return (
      <div className="rounded-xl bg-slate-950/95 border border-slate-700 p-3 text-xs text-slate-400">
        Загрузка карточки {vehicleId}…
      </div>
    );
  }

  // ---------------------------------------------------------------- Layer 2: citizen dossier
  if (citizenId) {
    if (!citizen) {
      return (
        <div className="rounded-xl bg-slate-950/95 border border-slate-700 p-3 text-xs text-slate-400">
          {error ?? `Загрузка досье ${citizenId}…`}
        </div>
      );
    }
    const income = BigInt(citizen.totalIncomeMinor);
    const net = BigInt(citizen.netSavingsMinor);
    return (
      <div className="rounded-xl bg-slate-950/95 backdrop-blur-md border border-emerald-600/50 shadow-2xl p-3 text-xs space-y-2.5">
        {header(
          <>
            <User className="w-4 h-4 text-emerald-400" />
            <span className="truncate">{citizen.fullName}</span>
            <span className="text-[10px] text-slate-500 font-mono">#{citizen.id}</span>
          </>
        )}
        <button
          onClick={() => setCitizenId(null)}
          className="flex items-center gap-1 text-[11px] text-sky-300 hover:text-sky-200"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> к машине {vehicle.plate}
        </button>

        <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
          <span className="text-slate-400">Возраст</span>
          <span>{citizen.age} лет</span>
          <span className="text-slate-400">Класс</span>
          <span>{citizen.classNameRu}</span>
          <span className="text-slate-400">Семья</span>
          <span>{citizen.familyRu}</span>
          <span className="text-slate-400">Статус</span>
          <span>{citizen.statusRu}</span>
        </div>

        <div className="space-y-1">
          <button
            onClick={() => onFocusTile(citizen.home.tileX, citizen.home.tileY)}
            className="w-full flex items-center gap-1.5 px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-left"
          >
            <Home className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span className="truncate">{citizen.home.label}</span>
          </button>
          <button
            onClick={() => onFocusTile(citizen.workplace.tileX, citizen.workplace.tileY)}
            className="w-full flex items-center gap-1.5 px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-left"
          >
            <MapPin className="w-3.5 h-3.5 text-sky-400 shrink-0" />
            <span className="truncate">
              {citizen.workplace.roleRu} · {citizen.workplace.label}
            </span>
          </button>
          <div className="text-[10px] text-slate-400 px-1">
            Дорога на работу: {citizen.commuteKm} км · {citizen.commuteModeRu}
          </div>
        </div>

        <div>
          <div className="text-[11px] font-semibold text-slate-300 mb-1">Бюджет семьи за месяц</div>
          <table className="w-full text-[11px]">
            <tbody>
              {citizen.income.map((l) => (
                <tr key={l.label}>
                  <td className="text-slate-400 pr-2">{l.label}</td>
                  <td className="text-right text-emerald-300 font-mono">+{money(citizen.currencySymbol, l.amountMinor)}</td>
                </tr>
              ))}
              {citizen.expenses.map((l) => (
                <tr key={l.label}>
                  <td className="text-slate-400 pr-2">{l.label}</td>
                  <td className="text-right text-rose-300 font-mono">−{money(citizen.currencySymbol, l.amountMinor)}</td>
                </tr>
              ))}
              <tr className="border-t border-slate-800">
                <td className="pt-1 font-semibold">Остаток</td>
                <td className={`pt-1 text-right font-mono font-semibold ${net < 0n ? "text-rose-400" : "text-emerald-300"}`}>
                  {net < 0n ? "−" : "+"}
                  {money(citizen.currencySymbol, (net < 0n ? -net : net).toString())}
                </td>
              </tr>
            </tbody>
          </table>
          {income > 0n && (
            <div className="mt-1.5 flex h-2 rounded overflow-hidden bg-slate-800" title="Структура расходов">
              {citizen.expenses.map((l, i) => (
                <div
                  key={l.label}
                  style={{ width: `${Math.min(100, (Number(BigInt(l.amountMinor) * 10_000n / income) / 100))}%` }}
                  className={["bg-rose-500", "bg-orange-400", "bg-amber-300", "bg-lime-400", "bg-sky-400", "bg-indigo-400", "bg-fuchsia-400", "bg-slate-400"][i % 8]}
                />
              ))}
            </div>
          )}
          <div className="mt-1 text-[10px] text-slate-400">
            Норма сбережений {(citizen.savingsRate * 100).toFixed(1)}% · Накопления{" "}
            {money(citizen.currencySymbol, citizen.cumulativeReserveMinor)}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-[11px] font-semibold mb-1">
            <span className="text-slate-300">Удовлетворённость</span>
            <span className={citizen.satisfaction >= 60 ? "text-emerald-300" : citizen.satisfaction >= 40 ? "text-amber-300" : "text-rose-400"}>
              {citizen.satisfaction}%
            </span>
          </div>
          <ul className="space-y-1">
            {citizen.thoughts.map((t) => (
              <li
                key={t.text}
                className={`px-2 py-1 rounded-lg text-[11px] ${t.delta >= 0 ? "bg-emerald-950/70 text-emerald-200" : "bg-rose-950/70 text-rose-200"}`}
              >
                «{t.text}» <span className="font-mono opacity-70">{t.delta > 0 ? `+${t.delta}` : t.delta}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- Layer 1: vehicle card
  const RoleIcon = vehicle.role === "freight" ? Truck : vehicle.role === "commuter" ? User : Bus;
  const cargoPct = vehicle.cargo ? Math.round((vehicle.cargo.payload / Math.max(0.01, vehicle.cargo.capacity)) * 100) : 0;
  return (
    <div className="rounded-xl bg-slate-950/95 backdrop-blur-md border border-sky-600/50 shadow-2xl p-3 text-xs space-y-2.5">
      {header(
        <>
          <RoleIcon className="w-4 h-4 text-sky-400 shrink-0" />
          <span className="truncate">{vehicle.typeNameRu}</span>
          <span className="text-[10px] text-slate-500 font-mono">#{vehicle.id}</span>
        </>
      )}

      <div className="flex items-center gap-2">
        <span
          className="px-2 py-0.5 rounded font-mono text-[11px] text-slate-950 font-bold"
          style={{ backgroundColor: `#${vehicle.liveryColorHex.toString(16).padStart(6, "0")}` }}
        >
          {vehicle.plate}
        </span>
        <span className="text-[10px] text-slate-400">{ROLE_LABELS[vehicle.role]}</span>
      </div>
      <div className="text-[11px] text-slate-300">{vehicle.ownerLabel}</div>

      <ol className="space-y-0.5 text-[11px] border-l-2 border-slate-700 pl-2">
        <li><span className="text-emerald-400">●</span> {vehicle.originLabel}</li>
        <li className="text-slate-400"><span className="text-amber-300">●</span> {vehicle.waypointLabel}</li>
        <li><span className="text-sky-400">●</span> {vehicle.destinationLabel}</li>
      </ol>

      {vehicle.cargo && (
        <div className="space-y-1">
          <div className="flex justify-between text-[11px]">
            <span>{vehicle.cargo.commodity}</span>
            <span className="font-mono">
              {vehicle.cargo.payload} / {vehicle.cargo.capacity} {vehicle.cargo.unit}
            </span>
          </div>
          <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
            <div className="h-full bg-amber-400" style={{ width: `${cargoPct}%` }} />
          </div>
          <div className="text-[10px] text-slate-400">
            Стоимость груза {money(vehicle.currencySymbol, vehicle.cargo.valueMinor)} · {vehicle.cargo.dutyLabel}
            {vehicle.cargo.dutyPaidMinor !== "0" && <> ({money(vehicle.currencySymbol, vehicle.cargo.dutyPaidMinor)})</>}
          </div>
        </div>
      )}
      {vehicle.passengers && (
        <div className="text-[11px]">
          Пассажиры: <span className="font-mono">{vehicle.passengers.onboard} / {vehicle.passengers.capacity}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
        <span className="text-slate-400">Скорость</span>
        <span className="font-mono">
          {vehicle.speedKmh} км/ч <span className="text-slate-500">(лимит {vehicle.speedLimitKmh})</span>
        </span>
        <span className="text-slate-400">Покрытие маршрута</span>
        <span className={`font-mono ${healthTone(vehicle.avgRoadHealth)}`}>{vehicle.avgRoadHealth}%</span>
        <span className="text-slate-400">Износ / 1000 проездов</span>
        <span className="font-mono">
          −{(vehicle.roadWearPerPassPercent * 1000).toLocaleString("ru-RU", { maximumSignificantDigits: 2 })}%{" "}
          <span className="text-slate-500">(×{vehicle.roadWearFactor} оси)</span>
        </span>
      </div>

      <div className="flex gap-1.5">
        <button
          onClick={() => setCitizenId(vehicle.driverCitizenId)}
          className="flex-1 px-2 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-semibold"
        >
          Досье водителя →
        </button>
        <button
          onClick={onToggleFollow}
          className={`px-2 py-1.5 rounded-lg border flex items-center gap-1 ${following ? "bg-sky-600 border-sky-400 text-white" : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}
          title="Камера следует за транспортом"
        >
          <Crosshair className="w-3.5 h-3.5" /> Следить
        </button>
      </div>
      <div className="text-[10px] text-slate-500">Смена водителя: осталось {vehicle.shiftHoursRemaining} ч</div>
    </div>
  );
};
