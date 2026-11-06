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
import { TopHudBar } from "./components/TopHudBar.tsx";
import { RegionSelectModal } from "./components/RegionSelectModal.tsx";
import { BuildToolbar } from "./components/BuildToolbar.tsx";
import { MacroDashboardModal } from "./components/MacroDashboardModal.tsx";
import { CouncilChatDrawer } from "./components/CouncilChatDrawer.tsx";
import { AdminGodModeTray } from "./components/AdminGodModeTray.tsx";
import { TransportPanel } from "./components/TransportPanel.tsx";
import { AgentInspectorPanel } from "./components/AgentInspectorPanel.tsx";
import { CityPanel } from "./components/CityPanel.tsx";

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
  const [landValueOverlay, setLandValueOverlay] = useState(false);

  const activeSectorRef = useRef<SectorId>(activeSectorId);
  activeSectorRef.current = activeSectorId;

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
      onSelectBuilding: (bId) => setSelectedBuildingId(bId),
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

    return () => {
      cancelled = true;
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
    sceneRef.current?.setLandValueOverlay(landValueOverlay);
  }, [landValueOverlay]);

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

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950">
      {/* Portrait Orientation Prompt for Mobile Screens (GDD §1.3 & §8.4) */}
      <div className="portrait-guard-overlay hidden fixed inset-0 z-[100] bg-slate-950 flex-col items-center justify-center p-6 text-center space-y-3">
        <RotateCw className="w-12 h-12 text-amber-400 animate-spin" />
        <h2 className="text-lg font-bold text-white">Поверните устройство горизонтально</h2>
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
            onOpenRegionModal={() => setShowRegionModal(true)}
            onOpenMacroModal={() => setShowMacroModal(true)}
            onToggleChat={() => setShowChatDrawer((v) => !v)}
            onToggleAdmin={() => setShowAdminTray((v) => !v)}
            onFocusSector={(s) => {
              if (s !== "core") setActiveSectorId(s);
              sceneRef.current?.focusSector(s, s === "core" ? 2.6 : 3.4);
            }}
            onFocusOverview={() => sceneRef.current?.focusOverview()}
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
              void sendCommand({ type: "bulldoze_building", sectorId: activeSectorId, buildingId })
            }
            transportOpen={showTransport}
            onToggleTransport={() => setShowTransport((v) => !v)}
            cityOpen={showCity}
            onToggleCity={() => setShowCity((v) => !v)}
          />
        </div>
      )}

      {/* Right Column: Vehicle -> Citizen Inspector & Transport Office (Sprint 5) */}
      {snapshot && (selectedVehicleId || showTransport || showCity) && (
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
          {showCity && (
            <CityPanel
              snapshot={snapshot}
              activeSectorId={activeSectorId}
              landValueOverlay={landValueOverlay}
              onToggleLandValueOverlay={() => setLandValueOverlay((v) => !v)}
              onFocusTile={(x, y) => {
                setFollowingVehicle(false);
                setUndergroundView(false);
                sceneRef.current?.focusTile(x, y, 6);
              }}
              onSendCommand={(cmd) => void sendCommand(cmd)}
              onClose={() => {
                setShowCity(false);
                setLandValueOverlay(false);
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
