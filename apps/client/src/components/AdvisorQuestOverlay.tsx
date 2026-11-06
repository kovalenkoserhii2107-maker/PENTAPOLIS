import React, { useState } from "react";
import {
  Award,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Coins,
  Compass,
  HardHat,
  Landmark,
  Route,
  Sparkles,
  Zap,
} from "lucide-react";
import {
  formatMoney,
  type AdvisorTipDto,
  type ClientCommand,
  type ExternalGatewayPoint,
  type SectorId,
  type StarterQuestStepDto,
  type StarterQuestStepId,
  type WorldSnapshotDto,
} from "@pentapolis/shared-sim";

export type QuestHighlightTarget = "network" | "zone" | "building" | "city" | null;

interface AdvisorQuestOverlayProps {
  snapshot: WorldSnapshotDto;
  activeSectorId: SectorId;
  gateways: readonly ExternalGatewayPoint[];
  onSendCommand: (cmd: ClientCommand) => void;
  onFocusTile: (x: number, y: number, zoom?: number) => void;
  onActivateStepTool: (stepId: StarterQuestStepId) => void;
  onOpenMacroModal: () => void;
}

const SEVERITY_DOT: Readonly<Record<AdvisorTipDto["severity"], string>> = {
  critical: "bg-rose-500 animate-pulse",
  warning: "bg-amber-400",
  info: "bg-emerald-400",
};

const SEVERITY_BORDER: Readonly<Record<AdvisorTipDto["severity"], string>> = {
  critical: "border-rose-500/60 bg-rose-950/40 text-rose-100",
  warning: "border-amber-500/50 bg-amber-950/30 text-amber-100",
  info: "border-slate-700/80 bg-slate-900/70 text-slate-200",
};

export function deriveQuestHighlight(quests: readonly StarterQuestStepDto[] | undefined): QuestHighlightTarget {
  if (!quests) return null;
  const active = quests.find((q) => !q.completed && !q.claimed);
  if (!active) return null;
  if (active.stepId === 1) return "network";
  if (active.stepId === 2) return "zone";
  if (active.stepId === 3) return "building";
  return "city";
}

export const AdvisorQuestOverlay: React.FC<AdvisorQuestOverlayProps> = ({
  snapshot,
  activeSectorId,
  gateways,
  onSendCommand,
  onFocusTile,
  onActivateStepTool,
  onOpenMacroModal,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [activeAdvisorTab, setActiveAdvisorTab] = useState<"quests" | "advisors">("quests");

  const sec = snapshot.sectors.find((s) => s.sectorId === activeSectorId) ?? snapshot.sectors[0]!;
  const quests = sec.quests ?? [];
  const claimedCount = quests.filter((q) => q.claimed).length;
  const readyToClaim = quests.filter((q) => q.completed && !q.claimed);
  const currentStep =
    readyToClaim[0] ?? quests.find((q) => !q.claimed) ?? null;
  const allClaimed = quests.length > 0 && claimedCount === quests.length;

  const sectorAdvisors = snapshot.advisors.find((a) => a.sectorId === activeSectorId)?.advisors ?? [];
  const logisticsAdv = sectorAdvisors.find((a) => a.advisorId === "logistics");
  const financeAdv = sectorAdvisors.find((a) => a.advisorId === "finance");
  const urbanAdv = sectorAdvisors.find((a) => a.advisorId === "urban");

  const cityResidents = snapshot.city.find((c) => c.sectorId === activeSectorId)?.residents ?? 0;
  const gw = gateways.find((g) => g.sectorId === activeSectorId);

  const advisorCards = [
    {
      id: "engineer",
      title: "Главный Инженер",
      role: "Сети, транспорт и энергетика",
      icon: HardHat,
      accent: "text-amber-300",
      topTip: logisticsAdv?.tips[0] ?? {
        severity: "info" as const,
        text: "Инфраструктура и энергосеть стабильны.",
        hint: "",
      },
      onAction: () => {
        if (gw) onFocusTile(gw.tileX, gw.tileY, 4.2);
      },
    },
    {
      id: "finance",
      title: "Министр Финансов и Председатель ЦБ",
      role: "Казна, ставка ЦБ и курс валюты",
      icon: Landmark,
      accent: "text-emerald-300",
      topTip: financeAdv?.tips[0] ?? {
        severity: "info" as const,
        text: "Двойная запись сведена (0.00), инфляция под контролем.",
        hint: "",
      },
      onAction: onOpenMacroModal,
    },
    {
      id: "urban",
      title: "Градостроитель",
      role: "Зонирование, экология и службы",
      icon: Building2,
      accent: "text-sky-300",
      topTip: urbanAdv?.tips[0] ?? {
        severity: "info" as const,
        text: "Кварталы развиваются гармонично.",
        hint: "",
      },
      onAction: () => onActivateStepTool(2),
    },
  ];

  const criticalCount = advisorCards.filter((c) => c.topTip.severity === "critical").length;

  if (collapsed) {
    return (
      <div className="pointer-events-auto fixed left-3 top-14 z-20 flex items-center gap-1.5">
        <button
          onClick={() => setCollapsed(false)}
          className="touch-target flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-950/92 backdrop-blur-md border border-amber-500/50 hover:border-amber-400 text-xs text-slate-100 shadow-xl transition"
        >
          <Sparkles className="w-3.5 h-3.5 text-amber-400" />
          <span className="font-semibold">
            {allClaimed ? "Советники мэрии" : `Квест мэра ${claimedCount}/${quests.length}`}
          </span>
          {readyToClaim.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-emerald-500 text-slate-950 font-bold text-[10px] animate-bounce">
              +{readyToClaim.length} грант
            </span>
          )}
          {criticalCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-rose-600 text-white font-bold text-[10px]">
              ! {criticalCount}
            </span>
          )}
          <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
        </button>
      </div>
    );
  }

  return (
    <aside className="pointer-events-auto fixed left-3 top-14 z-20 w-80 max-w-[calc(100vw-1.5rem)] max-h-[calc(100dvh-7.5rem)] overflow-y-auto rounded-xl bg-slate-950/92 backdrop-blur-md border border-slate-700/80 shadow-2xl text-xs text-slate-100">
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-1.5 px-3 py-2 bg-slate-950/95 border-b border-slate-800">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setActiveAdvisorTab("quests")}
            className={`px-2 py-1 rounded-md font-semibold transition flex items-center gap-1 ${
              activeAdvisorTab === "quests"
                ? "bg-amber-500/25 border border-amber-400/60 text-amber-200"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Award className="w-3.5 h-3.5 text-amber-400" />
            <span>Старт ({claimedCount}/4)</span>
          </button>
          <button
            onClick={() => setActiveAdvisorTab("advisors")}
            className={`px-2 py-1 rounded-md font-semibold transition flex items-center gap-1 ${
              activeAdvisorTab === "advisors"
                ? "bg-sky-500/25 border border-sky-400/60 text-sky-200"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <HardHat className="w-3.5 h-3.5 text-sky-400" />
            <span>3 Советника</span>
            {criticalCount > 0 && (
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
            )}
          </button>
        </div>

        <button
          onClick={() => setCollapsed(true)}
          className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition"
          title="Свернуть виджет советников"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
      </div>

      <div className="p-2.5 space-y-2.5">
        {activeAdvisorTab === "quests" ? (
          <>
            {/* Progress bar */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-slate-300">
                <span>Первые 15 минут в Секторе S{activeSectorId}</span>
                <span className="font-mono text-amber-300">
                  Население: {cityResidents.toLocaleString("ru-RU")} чел.
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-amber-400 to-emerald-400 transition-all duration-300"
                  style={{ width: `${quests.length > 0 ? (claimedCount / quests.length) * 100 : 0}%` }}
                />
              </div>
            </div>

            {/* Active or Claimable Quest Spotlight */}
            {currentStep ? (
              <div className="p-2.5 rounded-lg border border-amber-500/50 bg-slate-900/90 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="font-bold text-amber-200 leading-snug">{currentStep.titleRu}</div>
                  <span className="shrink-0 px-1.5 py-0.5 rounded bg-emerald-950 border border-emerald-600/60 text-emerald-300 font-mono text-[10px]">
                    +{sec.currencySymbol} {formatMoney(BigInt(currentStep.rewardLocalMinor))}
                  </span>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">{currentStep.descriptionRu}</p>

                <div className="flex items-center gap-1.5 pt-0.5">
                  {currentStep.completed && !currentStep.claimed ? (
                    <button
                      onClick={() =>
                        onSendCommand({
                          type: "claim_quest_reward",
                          sectorId: activeSectorId,
                          stepId: currentStep.stepId,
                        })
                      }
                      className="touch-target flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold shadow-lg shadow-emerald-950/60 animate-pulse transition"
                    >
                      <Coins className="w-3.5 h-3.5" />
                      <span>
                        Забрать грант +{sec.currencySymbol}{" "}
                        {formatMoney(BigInt(currentStep.rewardLocalMinor))}
                      </span>
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => onActivateStepTool(currentStep.stepId)}
                        className="touch-target flex-1 flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500/25 hover:bg-amber-500/35 border border-amber-400/70 text-amber-100 font-semibold transition"
                      >
                        {currentStep.stepId === 1 ? (
                          <Route className="w-3.5 h-3.5 text-amber-300" />
                        ) : currentStep.stepId === 3 ? (
                          <Zap className="w-3.5 h-3.5 text-amber-300" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                        )}
                        <span>Выбрать инструмент</span>
                      </button>
                      {currentStep.stepId === 1 && gw && (
                        <button
                          onClick={() => onFocusTile(gw.tileX, gw.tileY, 4.0)}
                          className="touch-target px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 transition flex items-center gap-1"
                          title="Навести камеру на внешний шлюз сектора"
                        >
                          <Compass className="w-3.5 h-3.5 text-sky-400" />
                          <span>Шлюз</span>
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-2.5 rounded-lg border border-emerald-500/50 bg-emerald-950/30 text-emerald-200 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>Все 4 стартовых гранта получены! Советники переведены в штатный мониторинг.</span>
              </div>
            )}

            {/* Compact Checklist of all 4 steps */}
            <div className="space-y-1">
              {quests.map((q) => (
                <div
                  key={q.stepId}
                  className={`flex items-center justify-between gap-2 px-2 py-1 rounded border text-[11px] ${
                    q.claimed
                      ? "bg-emerald-950/25 border-emerald-800/50 text-emerald-300/80 line-through"
                      : q.completed
                        ? "bg-emerald-950/60 border-emerald-500/70 text-emerald-100 font-semibold"
                        : "bg-slate-900/60 border-slate-800 text-slate-400"
                  }`}
                >
                  <span className="truncate">{q.titleRu}</span>
                  {q.claimed ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : q.completed ? (
                    <button
                      onClick={() =>
                        onSendCommand({
                          type: "claim_quest_reward",
                          sectorId: activeSectorId,
                          stepId: q.stepId,
                        })
                      }
                      className="px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold shrink-0"
                    >
                      Получить
                    </button>
                  ) : (
                    <span className="font-mono text-[10px] text-slate-500 shrink-0">
                      +{Math.round(q.rewardWcuUnits / 1000)}к МРЕ
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* Compact Mini-Strip of 3 Advisors right below quests */}
            <div className="pt-1 border-t border-slate-800 space-y-1">
              {advisorCards.map((adv) => {
                const Icon = adv.icon;
                return (
                  <button
                    key={adv.id}
                    onClick={() => setActiveAdvisorTab("advisors")}
                    className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-900 text-left transition"
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${SEVERITY_DOT[adv.topTip.severity]}`} />
                    <Icon className={`w-3.5 h-3.5 shrink-0 ${adv.accent}`} />
                    <span className="truncate text-[11px] text-slate-300">
                      <strong className="text-slate-100">{adv.title.split(" ")[0]}:</strong> {adv.topTip.text}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          /* Full 3 Advisors Panel */
          <div className="space-y-2">
            {advisorCards.map((adv) => {
              const Icon = adv.icon;
              return (
                <div
                  key={adv.id}
                  onClick={adv.onAction}
                  className={`cursor-pointer p-2.5 rounded-lg border transition hover:brightness-110 ${
                    SEVERITY_BORDER[adv.topTip.severity]
                  }`}
                >
                  <div className="flex items-center justify-between gap-1.5 mb-1">
                    <div className="flex items-center gap-1.5 font-bold">
                      <Icon className={`w-3.5 h-3.5 ${adv.accent}`} />
                      <span>{adv.title}</span>
                    </div>
                    <span className={`w-2 h-2 rounded-full ${SEVERITY_DOT[adv.topTip.severity]}`} />
                  </div>
                  <div className="text-[10px] text-slate-400 mb-1">{adv.role}</div>
                  <div className="text-[11px] font-medium leading-snug">{adv.topTip.text}</div>
                  {adv.topTip.hint && (
                    <div className="mt-1 text-[10px] text-amber-200/90">💡 {adv.topTip.hint}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
};
