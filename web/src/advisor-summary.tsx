import { useState, type ReactNode } from "react";

export function advisorBrief(description?: string | null): string {
  const text = description?.replace(/\s+/g, " ").trim() || "Advisor profile available in the roster.";
  return text.length > 180 ? text.slice(0, 177).trimEnd() + "…" : text;
}

export function AdvisorAvatar({ name, url }: { name: string; url?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  const visible = url && url !== failed;
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0]?.slice(0, 2) || "?";
  return <span className="advisor-avatar" aria-hidden="true" data-portrait-state={visible ? "image" : "placeholder"}>
    {visible ? <img src={url} alt="" onError={() => setFailed(url)} /> : initials.toUpperCase()}
  </span>;
}

export function AdvisorSummary({ name, description, portrait, portraitUrl, children }: {
  name: string; description?: string | null; portrait?: ReactNode; portraitUrl?: string | null; children?: ReactNode;
}) {
  return <span className="advisor-summary">
    {portrait ?? <AdvisorAvatar name={name} url={portraitUrl} />}
    <span className="advisor-summary-copy"><strong>{name}</strong>
      <span className="advisor-summary-description" title={description || undefined}>{advisorBrief(description)}</span>
      {children}
    </span>
  </span>;
}
