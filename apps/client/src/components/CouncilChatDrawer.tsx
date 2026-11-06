import React, { useState } from "react";
import { MessageSquare, Send, X } from "lucide-react";
import type { ChatMessageDto, SectorId } from "@pentapolis/shared-sim";

interface CouncilChatDrawerProps {
  messages: readonly ChatMessageDto[];
  activeSectorId: SectorId;
  onClose: () => void;
  onSendChat: (channel: ChatMessageDto["channel"], text: string) => void;
}

export const CouncilChatDrawer: React.FC<CouncilChatDrawerProps> = ({
  messages,
  activeSectorId,
  onClose,
  onSendChat,
}) => {
  const [channel, setChannel] = useState<ChatMessageDto["channel"]>("council");
  const [draft, setDraft] = useState("");

  const dmChannels = ([1, 2, 3, 4, 5] as const)
    .filter((s) => s !== activeSectorId)
    .map((other) => {
      const a = Math.min(activeSectorId, other) as SectorId;
      const b = Math.max(activeSectorId, other) as SectorId;
      return {
        key: `dm:${a}-${b}` as const,
        label: `ЛС S${other}`,
      };
    });

  const visibleMessages = messages.filter((m) => m.channel === channel);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    onSendChat(channel, draft);
    setDraft("");
  };

  return (
    <aside className="compact-modal pointer-events-auto fixed right-3 top-14 bottom-16 z-30 w-80 max-w-[calc(100vw-1.5rem)] flex flex-col rounded-xl bg-slate-950/95 backdrop-blur-md border border-slate-800 shadow-2xl text-xs overflow-hidden">
      <div className="compact-modal-header flex items-center justify-between px-3 py-2 bg-slate-900 border-b border-slate-800">
        <div className="flex items-center gap-1.5 font-bold text-white">
          <MessageSquare className="w-4 h-4 text-sky-400" />
          <span>Совет Полуострова</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Channel selector: Council + Bilateral DM */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-slate-950 border-b border-slate-800 overflow-x-auto">
        <button
          onClick={() => setChannel("council")}
          className={`px-2 py-0.5 rounded text-[11px] font-medium ${
            channel === "council" ? "bg-sky-600 text-white" : "bg-slate-900 text-slate-400"
          }`}
        >
          Общий Совет
        </button>
        {dmChannels.map((dm) => (
          <button
            key={dm.key}
            onClick={() => setChannel(dm.key)}
            className={`px-2 py-0.5 rounded text-[11px] font-medium ${
              channel === dm.key ? "bg-amber-600 text-white" : "bg-slate-900 text-slate-400"
            }`}
          >
            {dm.label}
          </button>
        ))}
      </div>

      {/* Messages */}
      <div className="flex-1 p-2.5 space-y-2 overflow-y-auto">
        {visibleMessages.length === 0 ? (
          <div className="text-slate-500 text-center py-6">
            Сообщений в этом канале пока нет. Заключайте сделки на газ, сталь и транзит!
          </div>
        ) : (
          visibleMessages.map((m) => (
            <div
              key={m.id}
              className={`p-2 rounded-lg border ${
                m.senderSector === "system"
                  ? "bg-amber-950/30 border-amber-500/30 text-amber-200"
                  : m.senderSector === activeSectorId
                    ? "bg-sky-950/40 border-sky-500/40 text-slate-100 ml-3"
                    : "bg-slate-900 border-slate-800 text-slate-200 mr-3"
              }`}
            >
              <div className="flex items-center justify-between text-[10px] text-slate-400 mb-0.5">
                <span className="font-semibold text-sky-300">{m.senderName}</span>
                <span>{m.timestampIso.slice(11, 16)}</span>
              </div>
              <p className="leading-snug break-words">{m.text}</p>
            </div>
          ))
        )}
      </div>

      <form onSubmit={handleSubmit} className="p-2 bg-slate-900 border-t border-slate-800 flex gap-1.5">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Написать в Совет или ЛС..."
          className="flex-1 px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-white focus:border-sky-400 focus:outline-none"
        />
        <button
          type="submit"
          className="px-2.5 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white"
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </form>
    </aside>
  );
};
