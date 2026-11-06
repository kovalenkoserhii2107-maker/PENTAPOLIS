import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import {
  GRID_HEIGHT,
  GRID_WIDTH,
  OwnerCode,
  SurfaceType,
  getMasterCatalogs,
  type ClientCommand,
  type CurrencyCode,
  type ExternalGatewayPoint,
  type ResourceDepositSite,
  type SectorId,
  type ServerMessage,
  type TrafficStateDto,
  type WorldSnapshotDto,
} from "@pentapolis/shared-sim";
import {
  PeninsulaScene,
  type ActiveToolState,
  type HoveredTileInfo,
} from "./renderer/PeninsulaScene.ts";
import type { HeatmapOverlayKind } from "./renderer/LotGenerator.ts";
import { TopHudBar } from "./components/TopHudBar.tsx";
import { RegionSelectModal } from "./components/RegionSelectModal.tsx";
import { BuildToolbar } from "./components/BuildToolbar.tsx";
import { MacroDashboardModal } from "./components/MacroDashboardModal.tsx";
import { CouncilChatDrawer } from "./components/CouncilChatDrawer.tsx";
import { AdminGodModeTray } from "./components/AdminGodModeTray.tsx";
import { TransportPanel } from "./components/TransportPanel.tsx";
import { AgentInspectorPanel } from "./components/AgentInspectorPanel.tsx";
import { CityPanel } from "./components/CityPanel.tsx";
import { GeopoliticsPanel } from "./components/GeopoliticsPanel.tsx";
import { BorderKppModal } from "./components/BorderKppModal.tsx";
import { StockExchangeModal } from "./components/StockExchangeModal.tsx";
import { MegaprojectModal } from "./components/MegaprojectModal.tsx";
import { AdvisorQuestOverlay, deriveQuestHighlight } from "./components/AdvisorQuestOverlay.tsx";
import { SoundEngine } from "./audio/SoundEngine.ts";

interface MapMetaResponse {
  readonly width: number;
  readonly height: number;
  readonly gateways: readonly ExternalGatewayPoint[];
  readonly deposits: readonly ResourceDepositSite[];
}

const SURFACE_NAMES_RU: Readonly<Record<number, string>> = {
  [SurfaceType.Sea]: "Море",
  [SurfaceType.Land]: "Суша",
  [SurfaceType.River]: "Река",
  [SurfaceType.Mainland]: "Материк",
};

export const App: React.FC = () => {
  const catalogs = useMemo(() => getMasterCatalogs(), []);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<PeninsulaScene | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [snapshot, setSnapshot] = useState<WorldSnapshotDto | null>(null);
  const [activeSectorId, setActiveSectorId] = useState<SectorId>(1);
  const [tool, setTool] = useState<ActiveToolState>({ mode: "inspect" });
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null);
  const [hoverTile, setHoverTile] = useState<HoveredTileInfo | null>(null);

  const [showRegionModal, setShowRegionModal] = useState(true);
  const [showMacroModal, setShowMacroModal] = useState(false);
  const [showChatDrawer, setShowChatDrawer] = useState(false);
  const [showAdminTray, setShowAdminTray] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [traffic, setTraffic] = useState<TrafficStateDto | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [followingVehicle, setFollowingVehicle] = useState(false);
  const [showTransport, setShowTransport] = useState(false);
  const [undergroundView, setUndergroundView] = useState(false);
  const [showCity, setShowCity] = useState(false);
  const [showGeo, setShowGeo] = useState(false);
  const [showKppModal, setShowKppModal] = useState(false);
  const [kppInitialPostId, setKppInitialPostId] = useState<string | null>(null);
  const [showExchangeModal, setShowExchangeModal] = useState(false);
  const [showMegaprojectModal, setShowMegaprojectModal] = useState(false);
  const [heatmapOverlay, setHeatmapOverlay] = useState<HeatmapOverlayKind>("none");
  const [gateways, setGateways] = useState<readonly ExternalGatewayPoint[]>([]);

  const soundRef = useRef<SoundEngine | null>(null);
  if (!soundRef.current) {
    soundRef.current = new SoundEngine();
  }
  const [audioMuted, setAudioMuted] = useState<boolean>(() => soundRef.current!.isMuted());
  const [audioVolume, setAudioVolume] = useState<number>(() => soundRef.current!.getVolume());

  const activeSectorRef = useRef<SectorId>(activeSectorId);
  activeSectorRef.current = activeSectorId;
  const snapshotRef = useRef<WorldSnapshotDto | null>(snapshot);
  snapshotRef.current = snapshot;
  const trafficRef = useRef<TrafficStateDto | null>(traffic);
  trafficRef.current = traffic;

  const pushToast = useCallback((ok: boolean, text: string) => {
    setToast({ ok, text });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const sendCommand = useCallback(
    async (cmd: ClientCommand) => {
      const snd = soundRef.current;
      if (snd) {
        if (cmd.type === "build_segment" || cmd.type === "repair_road") {
          snd.playRoadBuild();
        } else if (
          cmd.type === "place_building" ||
          cmd.type === "paint_zone" ||
          cmd.type === "found_megaproject"
        ) {
          snd.playBuildingPlace();
        } else if (
          cmd.type === "claim_quest_reward" ||
          cmd.type === "buyout_factory" ||
          cmd.type === "trade_stake" ||
          cmd.type === "preempt_takeover" ||
          cmd.type === "contribute_megaproject"
        ) {
          snd.playCashRegister();
        } else if (cmd.type === "admin_trigger_emergency") {
          snd.playEmergencySiren();
        }
      }

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(cmd));
        return;
      }
      // Fallback HTTP POST if WebSocket is reconnecting
      try {
        const res = await fetch("/api/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cmd),
        });
        const data = (await res.json()) as {
          ok: boolean;
          message: string;
          snapshot?: WorldSnapshotDto;
        };
        pushToast(data.ok, data.message);
        if (data.snapshot) setSnapshot(data.snapshot);
      } catch (err) {
        pushToast(false, err instanceof Error ? err.message : "Ошибка связи с сервером");
      }
    },
    [pushToast]
  );

  // Initialize Three.js Isometric Scene + Load Binary Map + Open WebSocket
  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return;

    const scene = new PeninsulaScene(container, catalogs, {
      onHoverTile: (info) => setHoverTile(info),
      onSelectBuilding: (bId) => {
        setSelectedBuildingId(bId);
        if (!bId) return;
        const b = snapshotRef.current?.buildings.find((item) => item.id === bId);
        if (!b) return;
        if (b.catalogId === "LOG-07") {
          setKppInitialPostId(b.id);
          setShowKppModal(true);
        } else if (b.catalogId === "FIN-02") {
          setShowExchangeModal(true);
        } else if (b.catalogId.startsWith("MEG-")) {
          setShowMegaprojectModal(true);
        }
      },
      onBuildSegment: (fromX, fromY, toX, toY, kind, isFlyover) => {
        void sendCommand({
          type: "build_segment",
          sectorId: activeSectorRef.current,
          kind,
          fromX,
          fromY,
          toX,
          toY,
          isFlyover,
        });
      },
      onPaintZone: (x, y, width, depth, zoneKind) => {
        void sendCommand({
          type: "paint_zone",
          sectorId: activeSectorRef.current,
          zoneKind,
          x,
          y,
          width,
          depth,
        });
      },
      onPlaceBuilding: (tileX, tileY, catalogId, orientationDeg) => {
        void sendCommand({
          type: "place_building",
          sectorId: activeSectorRef.current,
          catalogId,
          tileX,
          tileY,
          orientationDeg,
        });
      },
      onSelectVehicle: (vehicleId) => {
        setSelectedVehicleId(vehicleId);
        setFollowingVehicle(false);
        if (vehicleId) setSelectedBuildingId(null);
      },
      onToggleBusStop: (buildingId) => {
        setTool((prev) =>
          prev.mode === "bus_route"
            ? {
                mode: "bus_route",
                stopIds: prev.stopIds.includes(buildingId)
                  ? prev.stopIds.filter((id) => id !== buildingId)
                  : [...prev.stopIds, buildingId],
              }
            : prev
        );
      },
      onRepairSegment: (segmentId) => {
        void sendCommand({ type: "repair_road", sectorId: activeSectorRef.current, segmentId });
      },
      onDemolishBuilding: (buildingId) => {
        void sendCommand({ type: "demolish_building", sectorId: activeSectorRef.current, buildingId });
      },
      onDemolishZone: (zoneId) => {
        void sendCommand({ type: "demolish_zone", sectorId: activeSectorRef.current, zoneId });
      },
    });
    sceneRef.current = scene;

    let cancelled = false;
    void (async () => {
      try {
        const [metaRes, binRes, snapRes, trafficRes] = await Promise.all([
          fetch("/api/map-meta"),
          fetch("/api/map.bin"),
          fetch("/api/snapshot"),
          fetch("/api/traffic"),
        ]);
        if (cancelled) return;
        const meta = (await metaRes.json()) as MapMetaResponse;
        const buf = await binRes.arrayBuffer();
        const snap = (await snapRes.json()) as WorldSnapshotDto;

        setGateways(meta.gateways);

        const cellCount = GRID_WIDTH * GRID_HEIGHT;
        const surface = new Uint8Array(buf, 0, cellCount);
        const owner = new Uint8Array(buf, cellCount, cellCount);
        scene.loadMapTerrain(surface, owner, meta.gateways, meta.deposits);
        scene.applySnapshot(snap);
        setSnapshot(snap);
        const trafficState = (await trafficRes.json()) as TrafficStateDto;
        scene.setTrafficState(trafficState);
        setTraffic(trafficState);
      } catch (err) {
        pushToast(
          false,
          err instanceof Error
            ? `Не удалось загрузить карту полуострова: ${err.message}`
            : "Ошибка загрузки карты"
        );
      }
    })();

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        if (msg.type === "world_snapshot") {
          const prevEmergencies = snapshotRef.current?.emergencies.length ?? 0;
          if (msg.snapshot.emergencies.length > prevEmergencies) {
            soundRef.current?.playEmergencySiren();
          }
          setSnapshot(msg.snapshot);
          sceneRef.current?.applySnapshot(msg.snapshot);
        } else if (msg.type === "command_result") {
          pushToast(msg.ok, msg.message);
        } else if (msg.type === "notice_alert") {
          pushToast(true, `⚠️ ${msg.message}`);
        } else if (msg.type === "traffic_state") {
          setTraffic(msg.traffic);
          sceneRef.current?.setTrafficState(msg.traffic);
        }
      } catch {
        // Ignore malformed frame
      }
    };

    const ambienceTimer = window.setInterval(() => {
      if (sceneRef.current && soundRef.current) {
        soundRef.current.updateSpatialAmbience(
          sceneRef.current.getCameraState(),
          snapshotRef.current,
          trafficRef.current
        );
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearInterval(ambienceTimer);
      ws.close();
      scene.dispose();
      sceneRef.current = null;
    };
  }, [catalogs, pushToast, sendCommand]);

  // Keep Three.js tool & selection synchronized
  useEffect(() => {
    sceneRef.current?.setTool(tool);
  }, [tool]);

  useEffect(() => {
    sceneRef.current?.setSelectedVehicle(selectedVehicleId);
  }, [selectedVehicleId]);

  useEffect(() => {
    sceneRef.current?.followVehicle(followingVehicle ? selectedVehicleId : null);
  }, [followingVehicle, selectedVehicleId]);

  useEffect(() => {
    sceneRef.current?.setUndergroundView(undergroundView);
  }, [undergroundView]);

  useEffect(() => {
    sceneRef.current?.setHeatmapOverlay(heatmapOverlay);
  }, [heatmapOverlay]);

  // Global hotkey `~` / `Backquote` for God-Mode Admin Tray & `Escape` to return to Inspect
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.code === "Backquote") {
        e.preventDefault();
        setShowAdminTray((v) => !v);
      } else if (e.code === "Escape") {
        setTool({ mode: "inspect" });
        setSelectedVehicleId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selectedBuilding = useMemo(
    () => snapshot?.buildings.find((b) => b.id === selectedBuildingId) ?? null,
    [snapshot, selectedBuildingId]
  );

  const handleSelectSector = (sId: SectorId) => {
    setActiveSectorId(sId);
    sceneRef.current?.focusSector(sId, 3.4);
  };

  const handleClaimSector = (
    sectorId: SectorId,
    cityName: string,
    mayorName: string,
    currency: CurrencyCode
  ) => {
    void sendCommand({
      type: "claim_sector",
      sectorId,
      cityName,
      mayorName,
      currency,
    });
  };

  const activeSectorQuests = useMemo(
    () => snapshot?.sectors.find((s) => s.sectorId === activeSectorId)?.quests,
    [snapshot, activeSectorId]
  );
  const questHighlight = useMemo(() => deriveQuestHighlight(activeSectorQuests), [activeSectorQuests]);

  const handleActivateQuestStepTool = useCallback(
    (stepId: 1 | 2 | 3 | 4) => {
      if (stepId === 1) {
        setTool({ mode: "network", kind: "street_2lane", isFlyover: false });
        const gw = gateways.find((g) => g.sectorId === activeSectorId);
        if (gw) sceneRef.current?.focusTile(gw.tileX, gw.tileY, 3.8);
      } else if (stepId === 2) {
        setTool({ mode: "zone", zoneKind: "RES-01", brushSize: 6 });
      } else if (stepId === 3) {
        const hasWater = snapshotRef.current?.buildings.some(
          (b) => b.sectorId === activeSectorId && b.catalogId === "UTL-01"
        );
        const targetId = hasWater ? "ENG-01" : "UTL-01";
        const cat = catalogs.buildingsById.get(targetId);
        setTool({
          mode: "building",
          catalogId: targetId,
          width: Math.max(2, cat?.footprint.width || 6),
          depth: Math.max(2, cat?.footprint.depth || 6),
          orientationDeg: 0,
        });
      } else {
        setShowCity(true);
      }
    },
    [activeSectorId, catalogs, gateways]
  );

  return (
    <div
      className="relative w-screen h-screen overflow-hidden bg-slate-950"
      onClickCapture={(e) => {
        if ((e.target as HTMLElement | null)?.closest("button")) {
          soundRef.current?.playUiClick();
        }
      }}
    >
      {/* Portrait Orientation Prompt for Mobile Screens (GDD §1.3 & §8.4) */}
      <div className="portrait-guard-overlay hidden fixed inset-0 z-[100] bg-slate-950 flex-col items-center justify-center p-6 text-center space-y-3">
        <RotateCw className="w-12 h-12 text-amber-400 animate-spin" />
        <h2 className="text-lg font-bold text-white">
          Пожалуйста, поверните смартфон горизонтально для управления городом
        </h2>
        <p className="text-xs text-slate-400 max-w-xs">
          PENTAPOLIS спроектирован строго для альбомной ориентации (Landscape PWA) для работы с картой полуострова и макроэкономическими таблицами.
        </p>
      </div>

      {/* Fullscreen Three.js 2:1 Orthographic Isometric Viewport */}
      <div ref={viewportRef} className="absolute inset-0" />

      {/* UI Overlay Layer */}
      {snapshot && (
        <div className="pointer-events-none relative z-10 flex flex-col justify-between w-full h-full">
          <TopHudBar
            snapshot={snapshot}
            activeSectorId={activeSectorId}
            heatmapOverlay={heatmapOverlay}
            onChangeHeatmapOverlay={setHeatmapOverlay}
            onOpenRegionModal={() => setShowRegionModal(true)}
            onOpenMacroModal={() => setShowMacroModal(true)}
            onOpenKppModal={() => {
              setKppInitialPostId(null);
              setShowKppModal(true);
            }}
            onOpenExchangeModal={() => setShowExchangeModal(true)}
            onOpenMegaprojectModal={() => setShowMegaprojectModal(true)}
            onToggleChat={() => setShowChatDrawer((v) => !v)}
            onToggleAdmin={() => setShowAdminTray((v) => !v)}
            onFocusSector={(s) => {
              if (s !== "core") setActiveSectorId(s);
              sceneRef.current?.focusSector(s, s === "core" ? 2.6 : 3.4);
            }}
            onFocusOverview={() => sceneRef.current?.focusOverview()}
            audioMuted={audioMuted}
            audioVolume={audioVolume}
            onToggleMute={() => {
              const next = !audioMuted;
              soundRef.current?.setMuted(next);
              setAudioMuted(next);
            }}
            onChangeVolume={(vol) => {
              soundRef.current?.setVolume(vol);
              setAudioVolume(vol);
              if (vol > 0 && audioMuted) setAudioMuted(false);
            }}
          />

          <AdvisorQuestOverlay
            snapshot={snapshot}
            activeSectorId={activeSectorId}
            gateways={gateways}
            onSendCommand={(cmd) => void sendCommand(cmd)}
            onFocusTile={(x, y, zoom = 4.2) => sceneRef.current?.focusTile(x, y, zoom)}
            onActivateStepTool={handleActivateQuestStepTool}
            onOpenMacroModal={() => setShowMacroModal(true)}
          />

          <BuildToolbar
            snapshot={snapshot}
            activeSectorId={activeSectorId}
            buildingsCatalog={catalogs.buildings}
            tool={tool}
            selectedBuilding={selectedBuilding}
            onChangeTool={setTool}
            onBuyoutFactory={(buildingId) =>
              void sendCommand({ type: "buyout_factory", sectorId: activeSectorId, buildingId })
            }
            onUpgradeBuilding={(buildingId) =>
              void sendCommand({ type: "upgrade_building", sectorId: activeSectorId, buildingId })
            }
            onBulldozeBuilding={(buildingId) =>
              void sendCommand({ type: "demolish_building", sectorId: activeSectorId, buildingId })
            }
            transportOpen={showTransport}
            onToggleTransport={() => setShowTransport((v) => !v)}
            cityOpen={showCity}
            onToggleCity={() => setShowCity((v) => !v)}
            geoOpen={showGeo}
            onToggleGeo={() => setShowGeo((v) => !v)}
            questHighlight={questHighlight}
          />
        </div>
      )}

      {/* Right Column: Vehicle -> Citizen Inspector & Transport Office (Sprint 5) */}
      {snapshot && (selectedVehicleId || showTransport || showCity || showGeo) && (
        <div className="pointer-events-auto fixed right-3 top-14 z-30 w-80 max-h-[calc(100vh-8rem)] overflow-y-auto flex flex-col gap-2">
          {selectedVehicleId && (
            <AgentInspectorPanel
              vehicleId={selectedVehicleId}
              following={followingVehicle}
              onClose={() => setSelectedVehicleId(null)}
              onToggleFollow={() => setFollowingVehicle((v) => !v)}
              onFocusTile={(x, y) => {
                setFollowingVehicle(false);
                setUndergroundView(false);
                sceneRef.current?.focusTile(x, y, 6);
              }}
            />
          )}
          {showGeo && (
            <GeopoliticsPanel
              snapshot={snapshot}
              activeSectorId={activeSectorId}
              onSendCommand={(cmd) => void sendCommand(cmd)}
              onFocusTile={(x, y) => sceneRef.current?.focusTile(x, y, 3)}
              onOpenKppModal={() => {
                setKppInitialPostId(null);
                setShowKppModal(true);
              }}
              onOpenExchangeModal={() => setShowExchangeModal(true)}
              onOpenMegaprojectModal={() => setShowMegaprojectModal(true)}
              onClose={() => setShowGeo(false)}
            />
          )}
          {showCity && (
            <CityPanel
              snapshot={snapshot}
              activeSectorId={activeSectorId}
              landValueOverlay={heatmapOverlay === "land_value"}
              onToggleLandValueOverlay={() =>
                setHeatmapOverlay((prev) => (prev === "land_value" ? "none" : "land_value"))
              }
              onFocusTile={(x, y) => {
                setFollowingVehicle(false);
                setUndergroundView(false);
                sceneRef.current?.focusTile(x, y, 6);
              }}
              onSendCommand={(cmd) => void sendCommand(cmd)}
              onClose={() => {
                setShowCity(false);
                if (heatmapOverlay === "land_value") setHeatmapOverlay("none");
              }}
            />
          )}
          {showTransport && (
            <TransportPanel
              snapshot={snapshot}
              traffic={traffic}
              activeSectorId={activeSectorId}
              tool={tool}
              undergroundView={undergroundView}
              onClose={() => {
                setShowTransport(false);
                if (tool.mode === "bus_route" || tool.mode === "repair") setTool({ mode: "inspect" });
              }}
              onToggleUnderground={() => setUndergroundView((v) => !v)}
              onChangeTool={setTool}
              onCreateRoute={(stopIds, fleetSize, name) =>
                void sendCommand({
                  type: "create_bus_route",
                  sectorId: activeSectorId,
                  stopBuildingIds: [...stopIds],
                  fleetSize,
                  name,
                })
              }
              onDeleteRoute={(routeId) => void sendCommand({ type: "delete_bus_route", sectorId: activeSectorId, routeId })}
              onSetRoadService={(level) =>
                void sendCommand({ type: "update_policy", sectorId: activeSectorId, roadServiceLevel: level })
              }
              onRepairAll={() => void sendCommand({ type: "repair_road", sectorId: activeSectorId })}
            />
          )}
        </div>
      )}

      {/* Bottom-Right Tile & Controls Status Pill */}
      <div className="pointer-events-none fixed right-3 bottom-16 z-20 flex flex-col items-end gap-1 text-[11px]">
        {snapshot && snapshot.emergencies.length > 0 && (
          <div className="px-2.5 py-1 rounded bg-rose-950/90 border border-rose-500/60 text-rose-200 max-w-xs truncate">
            🚨 {snapshot.emergencies[snapshot.emergencies.length - 1]!.titleRu.split(":")[0]}
            {snapshot.emergencies[snapshot.emergencies.length - 1]!.statusRu &&
              ` — ${snapshot.emergencies[snapshot.emergencies.length - 1]!.statusRu}`}
          </div>
        )}
        <div className="px-2.5 py-1 rounded bg-slate-950/85 border border-slate-800 text-slate-300 font-mono">
          {hoverTile ? (
            <>
              ({hoverTile.tileX}, {hoverTile.tileY}) ·{" "}
              {SURFACE_NAMES_RU[hoverTile.surface] ?? "Акватория"} ·{" "}
              {hoverTile.owner === OwnerCode.CentralCore
                ? "Центральное Ядро"
                : hoverTile.owner >= 1 && hoverTile.owner <= 5
                  ? `Сектор S${hoverTile.owner}`
                  : "Внешние воды"}
            </>
          ) : (
            "ПКМ / Колесо / WASD — камера · ЛКМ — строительство"
          )}
        </div>
      </div>

      {/* Command Feedback Toast */}
      {toast && (
        <div
          className={`pointer-events-auto fixed top-14 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg border text-xs font-medium shadow-2xl transition ${
            toast.ok
              ? "bg-emerald-950/95 border-emerald-500 text-emerald-100"
              : "bg-rose-950/95 border-rose-500 text-rose-100"
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* Modals & Drawers */}
      {snapshot && showRegionModal && (
        <RegionSelectModal
          snapshot={snapshot}
          sectorProfiles={catalogs.sectors}
          activeSectorId={activeSectorId}
          onClose={() => setShowRegionModal(false)}
          onSelectActiveSector={handleSelectSector}
          onClaimSector={handleClaimSector}
        />
      )}

      {snapshot && showMacroModal && (
        <MacroDashboardModal
          snapshot={snapshot}
          activeSectorId={activeSectorId}
          onClose={() => setShowMacroModal(false)}
          onSendCommand={(cmd) => void sendCommand(cmd)}
        />
      )}

      {snapshot && showKppModal && (
        <BorderKppModal
          snapshot={snapshot}
          activeSectorId={activeSectorId}
          initialPostId={kppInitialPostId}
          onSendCommand={(cmd) => void sendCommand(cmd)}
          onFocusTile={(x, y) => sceneRef.current?.focusTile(x, y, 4.2)}
          onSelectBuildKpp={() => {
            const kppEntry = catalogs.buildingsById.get("LOG-07");
            setShowKppModal(false);
            setTool({
              mode: "building",
              catalogId: "LOG-07",
              width: Math.max(2, kppEntry?.footprint.width || 6),
              depth: Math.max(2, kppEntry?.footprint.depth || 6),
              orientationDeg: 0,
            });
          }}
          onClose={() => setShowKppModal(false)}
        />
      )}

      {snapshot && showExchangeModal && (
        <StockExchangeModal
          snapshot={snapshot}
          activeSectorId={activeSectorId}
          onSendCommand={(cmd) => void sendCommand(cmd)}
          onFocusTile={(x, y) => sceneRef.current?.focusTile(x, y, 4.5)}
          onClose={() => setShowExchangeModal(false)}
        />
      )}

      {snapshot && showMegaprojectModal && (
        <MegaprojectModal
          snapshot={snapshot}
          activeSectorId={activeSectorId}
          onSendCommand={(cmd) => void sendCommand(cmd)}
          onFocusCore={() => sceneRef.current?.focusSector("core", 2.6)}
          onClose={() => setShowMegaprojectModal(false)}
        />
      )}

      {snapshot && showChatDrawer && (
        <CouncilChatDrawer
          messages={snapshot.recentChat}
          activeSectorId={activeSectorId}
          onClose={() => setShowChatDrawer(false)}
          onSendChat={(channel, text) =>
            void sendCommand({
              type: "send_chat",
              senderSector: activeSectorId,
              channel,
              text,
            })
          }
        />
      )}

      {showAdminTray && (
        <AdminGodModeTray
          activeSectorId={activeSectorId}
          onClose={() => setShowAdminTray(false)}
          onSwitchSector={handleSelectSector}
          onTimeSkip={(jump) => void sendCommand({ type: "admin_time_skip", jump })}
          onResetSector={(sectorId) => void sendCommand({ type: "reset_sector", sectorId })}
          onTriggerEmergency={(sectorId, emergencyId) =>
            void sendCommand({ type: "admin_trigger_emergency", sectorId, emergencyId })
          }
        />
      )}
    </div>
  );
};
