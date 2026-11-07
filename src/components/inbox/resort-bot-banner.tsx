"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Hand, Loader2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type ActivityState = "idle" | "processing" | "no_reply" | "failed" | "simulated" | "accepted" | "sent" | "delivered" | "read";

interface ModeState {
  enabled: boolean;
  mode: "bot" | "human" | null;
  activity?: { state: ActivityState; at: string | null } | null;
}

const ACTIVITY_TEXT: Record<ActivityState, string> = {
  idle: "V-Farms bot is on for this guest.",
  processing: "V-Farms bot is preparing a reply…",
  no_reply: "V-Farms bot did not reply to the latest message. Reply yourself or check the server log.",
  failed: "The bot's reply could not be sent through MSG91. Reply yourself or check MSG91.",
  simulated: "Test mode: the bot's reply was recorded here but not sent to the guest.",
  accepted: "Bot replied — accepted by MSG91, not yet sent by WhatsApp.",
  sent: "Bot replied — sent by WhatsApp, delivery not confirmed yet.",
  delivered: "Bot replied — delivered to the guest.",
  read: "Bot replied — read by the guest.",
};

const POLL_MS = 4000;
const DELIVERY_POLL_MS = 10_000;

/**
 * V-Farms resort bot control for one conversation:
 *   - bot replying → [Take over]
 *   - paused (guest asked for a person, or staff replied) → [Return to bot]
 * Renders nothing when the account has no resort bot or the bot has not
 * handled this conversation yet. `refreshKey` changes when new messages
 * arrive, so a handoff made by the bot or a staff reply shows up.
 */
export function ResortBotBanner({
  conversationId,
  refreshKey,
}: {
  conversationId: string;
  refreshKey?: number | string;
}) {
  const [state, setState] = useState<ModeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch(`/api/admin/conversations/${conversationId}/mode`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ModeState>) : null))
      .then((s) => alive && setState(s))
      .catch(() => alive && setState(null));
    return () => {
      alive = false;
    };
  }, [conversationId, refreshKey, tick]);

  // While a reply is pending, re-check until it is delivered, fails or times out.
  const activityState = state?.mode === "bot" ? state.activity?.state : undefined;
  const pollMs = activityState === "processing" ? POLL_MS : activityState === "accepted" || activityState === "sent" ? DELIVERY_POLL_MS : 0;
  useEffect(() => {
    if (!pollMs) return;
    const t = setTimeout(() => setTick((n) => n + 1), pollMs);
    return () => clearTimeout(t);
  }, [pollMs, tick]);

  const setMode = useCallback(
    async (mode: "bot" | "human") => {
      setBusy(true);
      try {
        const res = await fetch(`/api/admin/conversations/${conversationId}/mode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          toast.error(j?.error ?? "Could not change the bot mode.");
          return;
        }
        setState((s) => (s ? { ...s, mode } : s));
        toast.success(mode === "bot" ? "The V-Farms bot will answer this guest again." : "You took over; the bot is paused for this guest.");
      } catch {
        toast.error("Network error. Please try again.");
      } finally {
        setBusy(false);
      }
    },
    [conversationId],
  );

  if (!state?.enabled || !state.mode) return null;

  const paused = state.mode === "human";
  const activity = state.activity?.state ?? "idle";
  const problem = !paused && (activity === "failed" || activity === "no_reply");
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-3 py-2 text-xs sm:px-4",
        paused
          ? "border-border bg-muted/40"
          : problem
            ? "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40"
            : "border-primary/20 bg-primary/5",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {!paused && activity === "processing" ? (
          <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-primary" />
        ) : (
          <Bot className={cn("h-3.5 w-3.5 flex-shrink-0", paused ? "text-muted-foreground" : problem ? "text-amber-600" : "text-primary")} />
        )}
        <span className="truncate font-medium text-foreground" title={paused ? undefined : ACTIVITY_TEXT[activity]}>
          {paused ? "V-Farms bot is paused for this guest — your team is replying." : ACTIVITY_TEXT[activity]}
        </span>
      </div>
      <button
        type="button"
        onClick={() => setMode(paused ? "bot" : "human")}
        disabled={busy}
        className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : paused ? <Undo2 className="h-3 w-3" /> : <Hand className="h-3 w-3" />}
        {paused ? "Return to bot" : "Take over"}
      </button>
    </div>
  );
}
