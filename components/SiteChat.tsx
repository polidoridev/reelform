"use client";

import { useEffect, useRef } from "react";

export interface ChatMessage {
  role: string;
  content: string;
}

// The conversation that lives under the live preview: the whole thread of what
// you asked for and what Claude changed, plus the narration of the edit that is
// running right now.
export function SiteChat({
  messages,
  draft,
  onDraftChange,
  onSend,
  busy,
  sendDisabled = false,
  maxLength,
  transcript,
  hint,
  placeholder = "Tell Claude what to change…",
  emptyState,
  busyLabel = "Reading your site…",
}: {
  messages: ChatMessage[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  sendDisabled?: boolean;
  maxLength?: number;
  transcript: string;
  hint: string;
  placeholder?: string;
  emptyState?: string;
  busyLabel?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Follow the conversation as it grows and as narration streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, transcript, busy]);

  // Hand focus back to the composer once an edit finishes.
  useEffect(() => {
    if (!busy) composerRef.current?.focus();
  }, [busy]);

  const empty = messages.length === 0 && !transcript && !busy;

  return (
    <div className="flex flex-col min-h-0 h-full bg-bg">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          {empty && (
            <p className="text-sm text-muted leading-relaxed">
              {emptyState ??
                "Scroll through your site above, then tell me exactly what to change: “make the hero headline bigger”, “swap the palette to something warmer”, “add a testimonials section under the second video”. I'll edit the page and it'll refresh in place."}
            </p>
          )}

          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary-soft/60 px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                  {m.content}
                </p>
              </div>
            ) : (
              <div key={i} className="flex gap-2.5">
                <span className="mono-label !text-primary shrink-0 pt-0.5">CLAUDE</span>
                <p className="text-sm leading-relaxed text-muted whitespace-pre-wrap">{m.content}</p>
              </div>
            )
          )}

          {(busy || transcript) && (
            <div className="flex gap-2.5">
              <span className="mono-label !text-primary shrink-0 pt-0.5">CLAUDE</span>
              <p className="text-sm leading-relaxed text-muted whitespace-pre-wrap">
                {transcript || busyLabel}
                {busy && <span className="rec-dot ml-1 inline-block align-middle" />}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-line px-5 py-3">
        <div className="mx-auto w-full max-w-3xl">
          <div className="flex gap-2 items-end">
            <textarea
              ref={composerRef}
              className="field flex-1 min-h-[46px] max-h-40 resize-y"
              placeholder={placeholder}
              value={draft}
              maxLength={maxLength}
              onChange={(e) => onDraftChange(e.target.value)}
              disabled={busy}
              onKeyDown={(e) => {
                // Enter sends and Shift+Enter starts a new line, per chat conventions.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (draft.trim() && !busy && !sendDisabled) onSend();
                }
              }}
            />
            <button
              onClick={onSend}
              disabled={busy || sendDisabled || !draft.trim()}
              className="btn-primary !py-3 !px-5 shrink-0"
            >
              {busy ? "Working…" : "Send"}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-faint">{hint}</p>
        </div>
      </div>
    </div>
  );
}
