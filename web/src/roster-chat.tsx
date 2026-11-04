import { AdvisorMessage } from "./advisor-message";
import { useEffect, useRef, useState } from "react";
import { FriendlyError } from "./human-disclosure";
import { friendlyError } from "./human-format";
import "./roster-chat.css";

export type RosterChatTurn = { role: string; content: string };
export type RosterChatApi = { post: <T>(u: string, b: unknown) => Promise<T>; streamPost?: <T>(u: string, b: unknown, onText: (text: string) => void, signal?: AbortSignal) => Promise<T> };
export type RosterChatProps = {
  rosterId: string;
  // Effective authenticated identity label (canonical user / applied demo
  // identity). NEVER a persistent browser UUID and NEVER a raw token: the
  // same browser signed in as someone else must never load this draft.
  identity: string;
  advisorName: string;
  rosterVersion?: number;
  complete?: boolean;
  missing?: string[];
  canChat?: boolean;
  api: RosterChatApi;
};

type ChatResponse = { answer: string; rosterVersion?: number };

// Storage key is scoped to the effective identity, never to a browser
// UUID. Identity labels (canonical user / applied demo identity) contain
// no token material; tokens must never be embedded in storage keys.
export function rosterDraftKey(identity: string, rosterId: string): string {
  return "roster-chat-draft:" + (identity || "owner") + ":" + rosterId;
}

function loadDraft(identity: string, rosterId: string): string {
  try {
    return window.localStorage.getItem(rosterDraftKey(identity, rosterId)) ?? "";
  } catch { return ""; }
}

// Direct roster conversation. Mounted ONLY from a selected roster advisor
// (App passes key={rosterEntryId} so every advisor gets an isolated panel
// instance: separate draft, history, and request lifecycle).
//
// Authority is the roster entry itself: if the entry is readable the chat
// is available. Board selection never gates it; the server enforces
// roster authorization on every call.
//
// Request hygiene: completed turns stay in `turns`. The unsent attempt is
// a separate `pendingAttempt` that is never appended until the server
// answers, so Retry resends the identical attempt and history sent to the
// server contains only preceding turns (the message itself is not
// duplicated into history).
export function RosterChatPanel(p: RosterChatProps) {
  const [turns, setTurns] = useState<RosterChatTurn[]>([]);
  const [pendingAttempt, setPendingAttempt] = useState<string | null>(null);
  const [msg, setMsg] = useState(() => loadDraft(p.identity, p.rosterId));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [partial, setPartial] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const followRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const epochRef = useRef(0);
  const versionRef = useRef(p.rosterVersion);
  const identityRef = useRef(p.identity);

  useEffect(() => {
    epochRef.current += 1;
    return () => { epochRef.current += 1; requestRef.current?.abort(); };
  }, []);

  useEffect(() => {
    if (versionRef.current === p.rosterVersion) return;
    versionRef.current = p.rosterVersion;
    epochRef.current += 1;
    requestRef.current?.abort(); setPartial("");
    setBusy(false);
    setPendingAttempt(null);
    setErr("");
  }, [p.rosterVersion]);

  // Authentication retirement: an identity change retires pending work,
  // clears the previous identity's conversation, and restores the new
  // identity's own saved draft. History and drafts never cross identities.
  useEffect(() => {
    if (identityRef.current === p.identity) return;
    identityRef.current = p.identity;
    epochRef.current += 1;
    requestRef.current?.abort(); setPartial("");
    setBusy(false);
    setPendingAttempt(null);
    setErr("");
    setTurns([]);
    setMsg(loadDraft(p.identity, p.rosterId));
  }, [p.identity, p.rosterId]);

  useEffect(() => {
    try { window.localStorage.setItem(rosterDraftKey(p.identity, p.rosterId), msg); } catch {}
  }, [msg, p.identity, p.rosterId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [turns, busy, partial]);

  const blocked = p.complete === false;
  const send = async (retryText?: string) => {
    const text = (retryText ?? msg).trim();
    if (!p.rosterId || !text || busy || blocked || p.canChat === false) return;
    const myEpoch = epochRef.current;
    const myIdentity = p.identity;
    const controller = new AbortController(); requestRef.current = controller; setPartial(""); followRef.current = true;
    setBusy(true);
    setErr("");
    setPendingAttempt(text);
    if (retryText === undefined) {
      setMsg("");
      try { window.localStorage.removeItem(rosterDraftKey(myIdentity, p.rosterId)); } catch {}
    }
    try {
      const url = "/api/roster/" + p.rosterId + "/chat";
      const body = { message: text, history: turns.slice(-10) };
      const r = p.api.streamPost
        ? await p.api.streamPost<ChatResponse>(url, body, value => { if (epochRef.current === myEpoch && identityRef.current === myIdentity) setPartial(value); }, controller.signal)
        : await p.api.post<ChatResponse>(url, body);
      if (epochRef.current !== myEpoch || p.identity !== myIdentity) return;
      setTurns([...turns, { role: "lead", content: text }, { role: "advisor", content: r.answer }]);
      setPendingAttempt(null); setPartial("");
    } catch (e) {
      if (epochRef.current !== myEpoch || p.identity !== myIdentity) return;
      setPartial(""); setErr(String(e));
    } finally {
      if (epochRef.current === myEpoch && p.identity === myIdentity) setBusy(false);
    }
  };

  return (
    <div className="card roster-chat" data-roster-chat={p.rosterId}>
      <h3>Chat with this advisor</h3>
      <p>
        Ask {p.advisorName || "this advisor"} a question to get a feel for
        their perspective and how they respond.
      </p>
      {blocked ? (
        <p role="alert">
          Finish creating this advisor ({(p.missing ?? []).join(", ")}) before chatting.
        </p>
      ) : (
        <div className="chatwrap">
          <div className="roster-chat-log" ref={scrollRef} onScroll={event => { const el = event.currentTarget; followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }} role="log" aria-label={"Chat with " + (p.advisorName || "advisor")}>
            {turns.length === 0 && pendingAttempt === null && (
              <p className="muted">No messages yet. Ask the first question below.</p>
            )}
            {turns.map((t, idx) => {
              const adv = t.role !== "lead";
              return (
                <div key={idx} className={"msg-row " + (adv ? "advisor" : "lead")}>
                  <div className="bubble">
                    <div className="bhead"><b>{adv ? (p.advisorName || "Advisor") : "You"}</b></div>
                    <div className="btext">{adv ? <AdvisorMessage text={t.content} /> : t.content}</div>
                  </div>
                </div>
              );
            })}
            {pendingAttempt !== null && (
              <div className="msg-row lead">
                <div className="bubble">
                  <div className="bhead"><b>You</b></div>
                  <div className="btext">{pendingAttempt}</div>
                </div>
              </div>
            )}
            {busy && (
              <div className="msg-row advisor">
                <div className="bubble" aria-label="Advisor response in progress"><div className="advisor-stream-status">Responding…</div>{partial && <AdvisorMessage text={partial} streaming />}</div>
              </div>
            )}
          </div>
        </div>
      )}
      <label>
        Message
        <textarea
          value={msg}
          disabled={blocked || p.canChat === false}
          onChange={(e) => setMsg(e.target.value)}
          placeholder={"Ask " + (p.advisorName || "this advisor") + " directly"}
          rows={2}
          aria-label={"Message " + (p.advisorName || "advisor")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
        />
      </label>
      <div className="meetctl">
        <button
          type="button"
          disabled={!p.rosterId || p.canChat === false || !msg.trim() || busy || blocked}
          onClick={() => void send()}
        >
          {busy ? "Sending…" : "Send"}
        </button>
        {pendingAttempt !== null && !busy && (
          <button type="button" onClick={() => void send(pendingAttempt)}>Retry</button>
        )}
      </div>
      {err && <FriendlyError friendly={friendlyError(err) || "Sending failed. Try again."} technical={err} />}
    </div>
  );
}
