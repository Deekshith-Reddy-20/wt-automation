"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { ChevronDown, FlaskConical, Loader2, RotateCcw, SendHorizontal, UserRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { adminSend } from "@/components/resort-admin/shared"
import type { RenderedMessage } from "@/lib/resort/bot/provider"
import type { BotState } from "@/lib/resort/bot/types"
import { cn } from "@/lib/utils"

interface Turn {
  state: BotState
  messages: RenderedMessage[]
  handoff: boolean
  simulated: string[]
}

type ChatItem =
  | { id: number; from: "guest"; text: string }
  | { id: number; from: "bot"; message: RenderedMessage }
  | { id: number; from: "note"; text: string }

let seq = 0

/** Staff test chat for the WhatsApp bot. Every turn runs on the server against live data; nothing is sent or saved. */
export function BotTestChat({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<ChatItem[]>([])
  const [state, setState] = useState<BotState | null>(null)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [openList, setOpenList] = useState<number | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [items, busy])

  async function send(input: { text: string; replyId: string | null }, shown: string) {
    if (busy) return
    setBusy(true)
    setOpenList(null)
    setItems((p) => [...p, { id: ++seq, from: "guest", text: shown }])
    try {
      const turn = await adminSend<Turn>("/api/admin/resort-bot/simulate", "POST", { state, ...input })
      setState(turn.state)
      setItems((p) => [
        ...p,
        ...turn.messages.map((message) => ({ id: ++seq, from: "bot" as const, message })),
        ...turn.simulated.map((t) => ({ id: ++seq, from: "note" as const, text: t })),
        ...(turn.messages.length === 0 && turn.handoff
          ? [{ id: ++seq, from: "note" as const, text: "The bot is now silent — a staff member would reply from the inbox. Type MENU or press Reset to start again." }]
          : []),
      ])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The test message failed")
      setItems((p) => [...p, { id: ++seq, from: "note", text: e instanceof Error ? e.message : "The test message failed" }])
    } finally {
      setBusy(false)
    }
  }

  function submitText() {
    const t = text.trim()
    if (!t) return
    setText("")
    void send({ text: t, replyId: null }, t)
  }

  function reset() {
    setItems([])
    setState(null)
    setOpenList(null)
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex h-[85vh] flex-col gap-3 p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border px-4 pt-4 pb-3">
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-primary" /> Test the WhatsApp bot
          </DialogTitle>
          <DialogDescription className="text-xs">
            You are the guest. Replies come from the real bot using your live calendar, pricing, property info and automation
            switches. Nothing is sent to WhatsApp and no enquiry, booking or lead is saved.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-2 overflow-y-auto bg-[#efeae2] px-3 py-3 dark:bg-zinc-900" aria-live="polite">
          {items.length === 0 && (
            <div className="mt-8 text-center text-sm text-muted-foreground">
              <p>Send a first message — for example “Hi” — to see the welcome menu.</p>
              <Button className="mt-3" size="sm" onClick={() => void send({ text: "Hi", replyId: null }, "Hi")} disabled={busy}>
                Say “Hi”
              </Button>
            </div>
          )}
          {items.map((item) =>
            item.from === "guest" ? (
              <div key={item.id} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-lg rounded-tr-none bg-[#d9fdd3] px-3 py-1.5 text-sm text-zinc-900 shadow-sm dark:bg-emerald-900 dark:text-emerald-50">
                  {item.text}
                </div>
              </div>
            ) : item.from === "note" ? (
              <div key={item.id} className="flex justify-center">
                <div className="flex max-w-[90%] items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-1 text-[11px] text-amber-900 shadow-sm dark:bg-amber-950/60 dark:text-amber-200">
                  <UserRound className="mt-0.5 h-3 w-3 flex-shrink-0" />
                  <span>Test only: {item.text}</span>
                </div>
              </div>
            ) : (
              <BotBubble
                key={item.id}
                message={item.message}
                listOpen={openList === item.id}
                onToggleList={() => setOpenList((o) => (o === item.id ? null : item.id))}
                disabled={busy}
                onChoose={(id, title) => void send({ text: title, replyId: id }, title)}
              />
            ),
          )}
          {busy && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-white px-3 py-2 shadow-sm dark:bg-zinc-800">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
          <div ref={bottom} />
        </div>

        <form
          className="flex items-center gap-2 border-t border-border px-3 pb-3 pt-1"
          onSubmit={(e) => {
            e.preventDefault()
            submitText()
          }}
        >
          <Button type="button" variant="ghost" size="icon" onClick={reset} aria-label="Reset the test conversation" title="Reset">
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message (try MENU, BACK or HUMAN)"
            maxLength={1000}
            aria-label="Guest message"
          />
          <Button type="submit" size="icon" disabled={busy || !text.trim()} aria-label="Send">
            <SendHorizontal className="h-4 w-4" />
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function BotBubble({
  message,
  listOpen,
  onToggleList,
  onChoose,
  disabled,
}: {
  message: RenderedMessage
  listOpen: boolean
  onToggleList: () => void
  onChoose: (id: string, title: string) => void
  disabled: boolean
}) {
  if (message.kind === "media") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] overflow-hidden rounded-lg rounded-tl-none bg-white text-sm text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100">
          {message.media === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={message.url} alt={message.caption ?? "Photo"} className="block max-h-64 w-full object-cover" loading="lazy" />
          ) : (
            <video src={message.url} controls preload="metadata" className="block max-h-64 w-full bg-black" />
          )}
          {message.caption && <p className="whitespace-pre-wrap px-3 py-1.5">{message.caption}</p>}
        </div>
      </div>
    )
  }
  const body = message.kind === "text" ? message.text : message.body
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] overflow-hidden rounded-lg rounded-tl-none bg-white text-sm text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100">
        <p className="whitespace-pre-wrap px-3 py-1.5">{body}</p>
        {message.kind === "buttons" &&
          message.buttons.map((b) => (
            <button
              key={b.id}
              type="button"
              disabled={disabled}
              onClick={() => onChoose(b.id, b.title)}
              className="block w-full border-t border-zinc-200 px-3 py-2 text-center text-sm font-medium text-sky-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-sky-400 dark:hover:bg-zinc-700"
            >
              {b.title}
            </button>
          ))}
        {message.kind === "list" && (
          <>
            <button
              type="button"
              onClick={onToggleList}
              className="flex w-full items-center justify-center gap-1 border-t border-zinc-200 px-3 py-2 text-sm font-medium text-sky-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-sky-400 dark:hover:bg-zinc-700"
              aria-expanded={listOpen}
            >
              {message.button} <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", listOpen && "rotate-180")} />
            </button>
            {listOpen && (
              <ul className="border-t border-zinc-200 dark:border-zinc-700">
                {message.sections.flatMap((s) => s.rows).map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onChoose(r.id, r.title)}
                      className="block w-full px-3 py-2 text-left hover:bg-zinc-50 disabled:opacity-50 dark:hover:bg-zinc-700"
                    >
                      <span className="block text-sm">{r.title}</span>
                      {r.description && <span className="block text-xs text-muted-foreground">{r.description}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}
