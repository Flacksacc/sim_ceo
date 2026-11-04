import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

export type ActivityAdvisorState = string;
export function mapAdvisorActivity(state: any, reason: any): string {
  const s = String(state ?? "");
  const r = String(reason ?? "");
  if (r === "reapproval-required") return "needs-approval";
  if (s === "queued") return "queued";
  if (s === "awaiting-selection") return "waiting-for-selection";
  if (s === "considering") return "considering";
  if (s === "responding") return "responding";
  if (s === "awaiting-publication") return "waiting-for-publication";
  if (s === "complete") return "complete";
  if (s === "abstained") return "abstained";
  if (s === "failed") return "failed";
  if (s === "interrupted") return "interrupted";
  return "idle";
}
export function mapSecretaryActivity(status: any): string {
  const s = String(status ?? "");
  if (s === "pending") return "pending";
  if (s === "inflight" || s === "answering") return "responding";
  if (s === "needs-clarification") return "waiting-for-clarification";
  if (s === "completed") return "complete";
  if (s === "failed") return "failed";
  if (s === "discarded") return "abstained";
  if (s === "interrupted" || s === "uncertain") return "interrupted";
  return "idle";
}

export interface MeetingActivityInput {
  boardId: string;
  meetingId: string;
  boardValid: boolean;
  meetingValid: boolean;
  sessGate: boolean;
  tab: string;
  get: <T>(path: string) => Promise<T>;
  isOriginStale: (o: any) => boolean;
  originOf: () => any;
}

export function useMeetingActivity(inp: MeetingActivityInput) {
  const [rev, setRev] = useState(0);
  const q = useQuery({
    queryKey: ["activity", inp.boardId, inp.meetingId],
    queryFn: () => inp.get<any>("/api/meetings/" + inp.meetingId + "/activity"),
    enabled: !!inp.boardId && !!inp.meetingId && inp.boardValid && inp.meetingValid && !inp.sessGate && inp.tab === "meet",
    refetchInterval: 4000,
    retry: false,
  });
  useEffect(() => { try { setRev((v: number) => v + 1); } catch {} }, [inp.boardId, inp.meetingId]);
  const advisorSnapshot = useMemo(() => {
    const m = new Map<string, string>();
    try {
      const snap: any = (q as any)?.data;
      if (!snap || !inp.boardId || !inp.meetingId) return m;
      if (inp.isOriginStale(inp.originOf())) return m;
      const disc: any = (snap as any)?.discussion;
      const dStatus = String((disc as any)?.status ?? "");
      const terminal = dStatus === "completed" || dStatus === "interrupted" || dStatus === "failed";
      const arr: any[] = (disc as any)?.advisors ?? [];
      for (const a of arr) {
        const id = String((a as any)?.advisorId ?? "");
        if (!id) continue;
        let act = mapAdvisorActivity((a as any)?.state, (a as any)?.reason);
        if (terminal && (act === "queued" || act === "waiting-for-selection" || act === "considering" || act === "responding" || act === "waiting-for-publication")) act = "interrupted";
        m.set(id, act);
      }
    } catch {}
    return m;
  }, [(q as any)?.data, rev, inp.boardId, inp.meetingId]);
  const secretaryActivity = useMemo(() => {
    try {
      const snap: any = (q as any)?.data;
      if (!snap || !inp.boardId || !inp.meetingId) return null;
      if (inp.isOriginStale(inp.originOf())) return null;
      const secs: any[] = (snap as any)?.secretary ?? [];
      let best: any = null;
      let bestTime = "";
      for (const s of secs) {
        const t = String((s as any)?.updatedAt ?? "");
        if (!best || t >= bestTime) { best = s; bestTime = t; }
      }
      if (!best) return null;
      return mapSecretaryActivity((best as any)?.status);
    } catch { return null; }
  }, [(q as any)?.data, rev, inp.boardId, inp.meetingId]);
  return { advisorSnapshot, secretaryActivity, activityData: (q as any)?.data ?? null };
}
