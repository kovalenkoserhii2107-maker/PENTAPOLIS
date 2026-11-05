import React, { useMemo, useState } from "react";
import {
  ArrowUpCircle,
  Building2,
  Bus,
  CheckCircle2,
  Circle,
  Factory,
  Hammer,
  MousePointer,
  Route,
  RotateCw,
  Trash2,
} from "lucide-react";
import {
  formatMoney,
  type BuildingCatalogEntry,
  type BuildingDto,
  type NetworkKind,
  type SectorId,
  type WorldSnapshotDto,
  type ZoneKind,
} from "@pentapolis/shared-sim";
import type { ActiveToolState } from "../renderer/PeninsulaScene.ts";

interface BuildToolbarProps {
  snapshot: WorldSnapshotDto;
  activeSectorId: SectorId;
  buildingsCatalog: readonly BuildingCatalogEntry[];
  tool: ActiveToolState;
  selectedBuilding: BuildingDto | null;
  onChangeTool: (tool: ActiveToolState) => void;
  onBuyoutFactory: (buildingId: string) => void;
  onUpgradeBuilding: (buildingId: string) => void;
  onBulldozeBuilding: (buildingId: string) => void;
  transportOpen: boolean;
  onToggleTransport: () => void;
}

const NETWORK_ITEMS: readonly { kind: NetworkKind; label: string; costHint: string }[] = [
  { kind: "street_2lane", label: "Улица 2 пол.", costHint: "180к/км" },
  { kind: "avenue_4lane", label: "Проспект 4 пол.", costHint: "420к/км" },
  { kind: "express_6lane", label: "Магистраль 6 пол.", costHint: "950к/км" },
  { kind: "heavy_bypass", label: "Грузовой обход", costHint: "1.35М/км" },
  { kind: "rail", label: "Ж/Д колея", costHint: "180к/км" },
  { kind: "pipeline", label: "Трубопровод", costHint: "450к/км" },
  { kind: "hv_power", label: "ЛЭП 500 МВт", costHint: "120к/км" },
  { kind: "metro_tunnel", label: "Метро (тоннель)", costHint: "60М/км" },
];

const ZONE_ITEMS: readonly { kind: ZoneKind; label: string; desc: string }[] = [
  { kind: "RES-01", label: "RES-01 Коттеджи", desc: "Низкая плотность" },
  { kind: "RES-02", label: "RES-02 Кварталы", desc: "Средняя этажность" },
  { kind: "RES-03", label: "RES-03 Высотки", desc: "Башни до 25 эт." },
  { kind: "COM-01", label: "COM-01 Лавки", desc: "Уличная торговля" },
  { kind: "COM-02", label: "COM-02 ТРЦ", desc: "Торговые центры" },
  { kind: "OFF-01", label: "OFF-01 Бизнес", desc: "Офисы инженеров" },
  { kind: "OFF-02", label: "OFF-02 Сити", desc: "Небоскрёбы элиты" },
];

type CatalogTab = "EXT" | "PLANT" | "ENG" | "LOG" | "CIV" | "BIZ" | "MEG";

const CATALOG_TABS: readonly { id: CatalogTab; label: string; prefixes: readonly string[] }[] = [
  { id: "EXT", label: "Добыча (Контур Б)", prefixes: ["EXT"] },
  { id: "PLANT", label: "Заводы (10%/90%)", prefixes: ["PRO", "CMP", "ASM"] },
  { id: "ENG", label: "Энергетика", prefixes: ["ENG"] },
  { id: "LOG", label: "Логистика и Транзит", prefixes: ["LOG", "TRN"] },
  { id: "CIV", label: "Службы и Город", prefixes: ["CIV", "UTL", "EDU", "HLT", "SAF"] },
  { id: "BIZ", label: "Бизнес и Туризм", prefixes: ["BIZ", "LEI", "TOU", "FIN"] },
  { id: "MEG", label: "Мегапроекты Ядра", prefixes: ["MEG"] },
];

export const BuildToolbar: React.FC<BuildToolbarProps> = ({
  snapshot,
  activeSectorId,
  buildingsCatalog,
  tool,
  selectedBuilding,
  onChangeTool,
  onBuyoutFactory,
  onUpgradeBuilding,
  onBulldozeBuilding,
  transportOpen,
  onToggleTransport,
}) => {
  const [drawerMode, setDrawerMode] = useState<"none" | "network" | "zone" | "catalog">("none");
  const [catTab, setCatTab] = useState<CatalogTab>("EXT");
  const [flyover, setFlyover] = useState(false);
  const [brushSize, setBrushSize] = useState(6);
  const [orientationDeg, setOrientationDeg] = useState<0 | 45 | 90 | 135>(0);

  const sec = snapshot.sectors.find((s) => s.sectorId === activeSectorId) ?? snapshot.sectors[0]!;

  // 4-Step Starter Quest Progress (GDD §6.1)
  const sectorSegments = snapshot.segments.filter(
    (sg) => sg.sectorId === activeSectorId && !sg.id.startsWith("GW-STUB-")
  );
  const sectorBuildings = snapshot.buildings.filter((b) => b.sectorId === activeSectorId);
  const sectorZones = snapshot.zones.filter((z) => z.sectorId === activeSectorId);

  const qRoadDone = sectorSegments.length > 0;
  const qPowerDone = sectorBuildings.some((b) => b.catalogId.startsWith("ENG-"));
  const qResDone = sectorZones.some((z) => z.zoneKind.startsWith("RES-"));
  const qIndDone = sectorBuildings.some(
    (b) => b.catalogId.startsWith("EXT-") || b.catalogId.startsWith("PRO-")
  );

  const filteredBuildings = useMemo(() => {
    const prefixes = CATALOG_TABS.find((t) => t.id === catTab)?.prefixes ?? ["EXT"];
    return buildingsCatalog.filter(
      (b) =>
        prefixes.includes(b.prefix) &&
        !b.footprint.isLine &&
        b.prefix !== "RES" &&
        b.prefix !== "COM" &&
        b.prefix !== "OFF"
    );
  }, [buildingsCatalog, catTab]);

  const selectedCatalogEntry = selectedBuilding
    ? buildingsCatalog.find((b) => b.id === selectedBuilding.catalogId)
    : undefined;

  const rotateNext = () => {
    const order: readonly (0 | 45 | 90 | 135)[] = [0, 45, 90, 135];
    const next = order[(order.indexOf(orientationDeg) + 1) % order.length]!;
    setOrientationDeg(next);
    if (tool.mode === "building") {
      onChangeTool({ ...tool, orientationDeg: next });
    }
  };

  return (
    <>
      {/* Left Floating Starter Advisor Quest Card + Selected Building Inspector */}
      <div className="pointer-events-auto fixed left-3 top-14 z-20 w-72 space-y-2">
        <div className="rounded-lg bg-slate-950/88 backdrop-blur-md border border-slate-800 p-2.5 text-xs shadow-xl">
          <div className="font-bold text-amber-300 mb-1.5 flex items-center justify-between">
            <span>Советники S{activeSectorId}: Первые шаги</span>
            <span className="text-[10px] text-slate-400">
              {[qRoadDone, qPowerDone, qResDone, qIndDone].filter(Boolean).length}/4
            </span>
          </div>
          <ul className="space-y-1 text-[11px]">
            <li className="flex items-center gap-1.5">
              {qRoadDone ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              ) : (
                <Circle className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              )}
              <span className={qRoadDone ? "line-through text-slate-400" : "text-slate-200"}>
                1. Протянуть дорогу (90°/45°) от Шлюза
              </span>
            </li>
            <li className="flex items-center gap-1.5">
              {qPowerDone ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              ) : (
                <Circle className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              )}
              <span className={qPowerDone ? "line-through text-slate-400" : "text-slate-200"}>
                2. Построить электростанцию (ENG)
              </span>
            </li>
            <li className="flex items-center gap-1.5">
              {qResDone ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              ) : (
                <Circle className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              )}
              <span className={qResDone ? "line-through text-slate-400" : "text-slate-200"}>
                3. Разметить жилую зону (RES-01)
              </span>
            </li>
            <li className="flex items-center gap-1.5">
              {qIndDone ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              ) : (
                <Circle className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              )}
              <span className={qIndDone ? "line-through text-slate-400" : "text-slate-200"}>
                4. Запустить профильную шахту или завод
              </span>
            </li>
          </ul>
        </div>

        {/* Selected Building Equity & Action Inspector */}
        {selectedBuilding && selectedCatalogEntry && (
          <div className="rounded-lg bg-slate-950/95 backdrop-blur-md border border-sky-500/50 p-3 text-xs shadow-2xl space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[10px] font-mono text-sky-400">
                  {selectedBuilding.catalogId} · Ур.{selectedBuilding.level}/
                  {selectedCatalogEntry.maxLevel}
                </div>
                <div className="font-bold text-white text-sm">{selectedCatalogEntry.nameRu}</div>
              </div>
              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-slate-300">
                {selectedBuilding.width}×{selectedBuilding.depth}
              </span>
            </div>

            <div className="text-[11px] text-slate-300 space-y-0.5">
              <div>
                Доля Мэрии:{" "}
                <strong className="text-amber-300">
                  {Math.round(selectedBuilding.cityEquityShare * 100)}%
                </strong>{" "}
                / Частный капитал:{" "}
                <strong>{Math.round((1 - selectedBuilding.cityEquityShare) * 100)}%</strong>
              </div>
              <div>
                Статус:{" "}
                {selectedBuilding.stalledAwaitingPrivate ? (
                  <span className="text-amber-400 font-semibold">
                    Замерший кран (ждёт частников 90%)
                  </span>
                ) : selectedBuilding.constructionProgress < 1 ? (
                  <span className="text-sky-300">
                    Стройка {Math.round(selectedBuilding.constructionProgress * 100)}%
                  </span>
                ) : (
                  <span className="text-emerald-400">В строю (100%)</span>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5 pt-1">
              {selectedBuilding.cityEquityShare < 0.999 && (
                <button
                  onClick={() => onBuyoutFactory(selectedBuilding.id)}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold text-[11px]"
                  title="Муниципальный выкуп 100% акций завода (Backstop / Eminent Domain)"
                >
                  <Factory className="w-3.5 h-3.5" />
                  <span>Выкуп 100%</span>
                </button>
              )}

              {selectedBuilding.level < selectedCatalogEntry.maxLevel &&
                !selectedBuilding.stalledAwaitingPrivate && (
                  <button
                    onClick={() => onUpgradeBuilding(selectedBuilding.id)}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-semibold text-[11px]"
                  >
                    <ArrowUpCircle className="w-3.5 h-3.5" />
                    <span>Ур.{selectedBuilding.level + 1}</span>
                  </button>
                )}

              <button
                onClick={() => onBulldozeBuilding(selectedBuilding.id)}
                className="flex items-center justify-center gap-1 px-2 py-1 rounded bg-rose-700 hover:bg-rose-600 text-white text-[11px]"
                title="Снести объект (совместные заводы требуют 100% выкупа)"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Landscape Construction Dock */}
      <div className="pointer-events-auto fixed bottom-3 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2 max-w-[96vw]">
        {/* Expandable Sub-Palette */}
        {drawerMode === "network" && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-950/95 backdrop-blur-md border border-slate-700 shadow-2xl text-xs">
            <label className="flex items-center gap-1.5 px-2 py-1 rounded bg-slate-900 border border-slate-800 text-amber-300 cursor-pointer mr-1">
              <input
                type="checkbox"
                checked={flyover}
                onChange={(e) => {
                  const next = e.target.checked;
                  setFlyover(next);
                  if (tool.mode === "network") {
                    onChangeTool({ ...tool, isFlyover: next });
                  }
                }}
              />
              <span>Эстакада Z=+1</span>
            </label>
            {NETWORK_ITEMS.map((item) => {
              const active = tool.mode === "network" && tool.kind === item.kind;
              return (
                <button
                  key={item.kind}
                  onClick={() =>
                    onChangeTool({ mode: "network", kind: item.kind, isFlyover: flyover })
                  }
                  className={`px-2.5 py-1.5 rounded-lg border text-left transition ${
                    active
                      ? "bg-sky-600/30 border-sky-400 text-white"
                      : "bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-200"
                  }`}
                >
                  <div className="font-semibold text-[11px]">{item.label}</div>
                  <div className="text-[10px] text-slate-400">{item.costHint}</div>
                </button>
              );
            })}
          </div>
        )}

        {drawerMode === "zone" && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-950/95 backdrop-blur-md border border-slate-700 shadow-2xl text-xs">
            <div className="flex items-center gap-1 mr-2 bg-slate-900 px-2 py-1 rounded border border-slate-800">
              <span className="text-[10px] text-slate-400">Кисть:</span>
              {[4, 6, 10].map((sz) => (
                <button
                  key={sz}
                  onClick={() => {
                    setBrushSize(sz);
                    if (tool.mode === "zone") onChangeTool({ ...tool, brushSize: sz });
                  }}
                  className={`px-1.5 py-0.5 rounded text-[11px] ${
                    brushSize === sz ? "bg-emerald-600 text-white" : "text-slate-300"
                  }`}
                >
                  {sz}×{sz}
                </button>
              ))}
            </div>
            {ZONE_ITEMS.map((z) => {
              const active = tool.mode === "zone" && tool.zoneKind === z.kind;
              return (
                <button
                  key={z.kind}
                  onClick={() =>
                    onChangeTool({ mode: "zone", zoneKind: z.kind, brushSize })
                  }
                  className={`px-2.5 py-1.5 rounded-lg border text-left transition ${
                    active
                      ? "bg-emerald-600/30 border-emerald-400 text-white"
                      : "bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-200"
                  }`}
                >
                  <div className="font-semibold text-[11px]">{z.label}</div>
                  <div className="text-[10px] text-slate-400">{z.desc}</div>
                </button>
              );
            })}
          </div>
        )}

        {drawerMode === "catalog" && (
          <div className="w-[840px] max-w-[94vw] rounded-xl bg-slate-950/95 backdrop-blur-md border border-slate-700 p-2.5 shadow-2xl text-xs space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex flex-wrap gap-1">
                {CATALOG_TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setCatTab(t.id)}
                    className={`px-2.5 py-1 rounded text-[11px] font-semibold transition ${
                      catTab === t.id
                        ? "bg-amber-500 text-slate-950"
                        : "bg-slate-900 text-slate-300 hover:bg-slate-800"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <button
                onClick={rotateNext}
                className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-sky-300 text-[11px]"
                title="Поворот площадки 0° / 45° / 90° / 135°"
              >
                <RotateCw className="w-3.5 h-3.5" />
                <span>Угол {orientationDeg}°</span>
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 max-h-44 overflow-y-auto pr-1">
              {filteredBuildings.map((b) => {
                const isCoInvest = b.ownershipContour === "co_invested_10_90";
                const mayorShare = isCoInvest ? 0.1 : b.prefix === "MEG" ? 0.25 : 1.0;
                const mayorCostMinor = BigInt(
                  Math.round(b.buildCostLv1Units * sec.fxRatePerWcu * mayorShare * 100)
                );
                const selected = tool.mode === "building" && tool.catalogId === b.id;
                return (
                  <button
                    key={b.id}
                    onClick={() =>
                      onChangeTool({
                        mode: "building",
                        catalogId: b.id,
                        width: Math.max(2, b.footprint.width || 4),
                        depth: Math.max(2, b.footprint.depth || 4),
                        orientationDeg,
                      })
                    }
                    className={`p-2 rounded-lg border text-left transition ${
                      selected
                        ? "bg-amber-500/25 border-amber-400 text-white"
                        : "bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-200"
                    }`}
                  >
                    <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono">
                      <span>{b.id}</span>
                      <span>
                        {Math.max(2, b.footprint.width)}×{Math.max(2, b.footprint.depth)} · {b.unlockStage}
                      </span>
                    </div>
                    <div className="font-semibold text-[11px] truncate text-white">{b.nameRu}</div>
                    <div className="mt-0.5 flex items-center justify-between text-[10px]">
                      <span className="text-emerald-400 font-mono">
                        {sec.currencySymbol} {formatMoney(mayorCostMinor)}
                      </span>
                      {isCoInvest && (
                        <span className="px-1 rounded bg-sky-500/20 text-sky-300">10% Мэрия</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Main Primary Tool Pill Bar */}
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-slate-950/95 backdrop-blur-md border border-slate-700 shadow-2xl text-xs">
          <button
            onClick={() => {
              setDrawerMode("none");
              onChangeTool({ mode: "inspect" });
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full font-medium transition ${
              tool.mode === "inspect" && drawerMode === "none"
                ? "bg-sky-600 text-white"
                : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            <MousePointer className="w-3.5 h-3.5" />
            <span>Осмотр</span>
          </button>

          <button
            onClick={() => {
              const next = drawerMode === "network" ? "none" : "network";
              setDrawerMode(next);
              if (next === "network") {
                onChangeTool({ mode: "network", kind: "street_2lane", isFlyover: flyover });
              }
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full font-medium transition ${
              drawerMode === "network" || tool.mode === "network"
                ? "bg-sky-600 text-white"
                : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            <Route className="w-3.5 h-3.5" />
            <span>Сети 90°/45°</span>
          </button>

          <button
            onClick={() => {
              const next = drawerMode === "zone" ? "none" : "zone";
              setDrawerMode(next);
              if (next === "zone") {
                onChangeTool({ mode: "zone", zoneKind: "RES-01", brushSize });
              }
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full font-medium transition ${
              drawerMode === "zone" || tool.mode === "zone"
                ? "bg-emerald-600 text-white"
                : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            <Building2 className="w-3.5 h-3.5" />
            <span>Зоны RCI</span>
          </button>

          <button
            onClick={() => setDrawerMode(drawerMode === "catalog" ? "none" : "catalog")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full font-medium transition ${
              drawerMode === "catalog" || tool.mode === "building"
                ? "bg-amber-500 text-slate-950 font-bold"
                : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            <Hammer className="w-3.5 h-3.5" />
            <span>Каталог (127 объектов)</span>
          </button>

          <button
            onClick={onToggleTransport}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full font-medium transition ${
              transportOpen || tool.mode === "bus_route" || tool.mode === "repair"
                ? "bg-indigo-600 text-white"
                : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            <Bus className="w-3.5 h-3.5" />
            <span>Транспорт</span>
          </button>
        </div>
      </div>
    </>
  );
};
