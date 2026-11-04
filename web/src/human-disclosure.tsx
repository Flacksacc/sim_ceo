import { useState } from "react";
import "./human-feedback.css";

// Progressive disclosure for supporting content. People see plain language
// first. Raw identifiers, hashes, and payloads are never displayed in the
// UI — not even behind disclosures. Anything support needs travels in the
// wire protocol and export files, or leaves via an explicit copy action.

export function HumanDisclosure(props: {
  summary: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="human-disclosure" open={props.defaultOpen === true}>
      <summary className="human-disclosure-summary">{props.summary}</summary>
      <div className="human-disclosure-body">{props.children}</div>
    </details>
  );
}

// Plain-language problem first. The raw server text is never displayed;
// "Copy error report" puts the full text on the clipboard for support
// without showing identifiers or payloads on screen.
export function FriendlyError(props: { friendly: string; technical?: string }) {
  const [copied, setCopied] = useState(false);
  if (!props.technical) return <p role="alert" className="human-error">{props.friendly}</p>;
  return (
    <p role="alert" className="human-error">
      {props.friendly}
      {" "}
      <button
        type="button"
        className="human-error-details-toggle"
        onClick={() => {
          const done = () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          };
          try {
            const clip = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
            if (clip) {
              void clip.writeText(props.technical ?? "").then(done, done);
            } else {
              done();
            }
          } catch {
            done();
          }
        }}
      >
        {copied ? "Copied error report" : "Copy error report"}
      </button>
    </p>
  );
}

export type StatusTone = "open" | "progress" | "done" | "muted";

export function StatusChip(props: { label: string; tone: StatusTone }) {
  return <span className={"human-status human-status-" + props.tone}>{props.label}</span>;
}
