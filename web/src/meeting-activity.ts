import { useEffect, useMemo, useRef, useState } from "react";
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

export function hasActivityFetchFailed(q: { error?: unknown; isError?: boolean; failureCount?: number; data?: unknown }): boolean {
  try {
    if ((q as any)?.error) return true;
    if ((q as any)?.isError) return true;
    if (typeof (q as any)?.failureCount === "number" && (q as any).failureCount > 0 && !(q as any)?.data) return true;
    return false;
  } catch { return false; }
}

export function shouldUseActivitySnapshot(args: { reqStale: boolean; fetchFailed: boolean }): boolean {
  try {
    if (args.reqStale) return false;
    if (args.fetchFailed) return false;
    return true;
  } catch { return false; }
}

// Explicit availability for the activity snapshot. "available" means the hook
// holds a live identity-owned snapshot the rail may render. "loading" covers
// the initial fetch with no data, "paused" covers polling that is not live
// (tab hidden, session gate, offline pause, live off) while retained data
// exists, "unavailable" covers errored or identity-stale snapshots.
// Paused/loading/unavailable snapshots never render as idle or responding.
export type ActivityAvailability = "available" | "loading" | "paused" | "unavailable";

export function resolveActivityAvailability(args: {
  reqStale: boolean;
  fetchFailed: boolean;
  queryEnabled: boolean;
  hasData: boolean;
  isPaused: boolean;
  liveOff: boolean;
  isLoading: boolean;
}): ActivityAvailability {
  try {
    if (args.reqStale) return "unavailable";
    if (args.fetchFailed) return "unavailable";
    if (!args.queryEnabled) return args.hasData ? "paused" : "unavailable";
    if (!args.hasData) return "loading";
    if (args.isPaused || args.liveOff) return "paused";
    void args.isLoading;
    return "available";
  } catch { return "unavailable"; }
}

// Aggregate the private caller-owned secretary snapshot. Multiple owned
// nonces/tabs can coexist: an actual active request (pending/inflight/
// answering) always wins over any terminal history, so a newer terminal
// timestamp from tab A can never hide tab B that is still working. With no
// active request, a waiting clarification wins over terminal history;
// otherwise the newest terminal entry is shown.
export function selectSecretaryActivity(secs: any[]): string | null {
  try {
    if (!Array.isArray(secs) || secs.length === 0) return null;
    const owned = secs.filter((s) => s && typeof (s as any).status === "string" && String((s as any).status).length > 0);
    if (owned.length === 0) return null;
    const active = owned.filter((s) => {
      const st = String((s as any).status);
      return st === "pending" || st === "inflight" || st === "answering";
    });
    const pickNewest = (rows: any[]): any | null => {
      let best: any = null;
      let bestTime = "";
      for (const s of rows) {
        const t = String((s as any)?.updatedAt ?? "");
        if (!best || t >= bestTime) { best = s; bestTime = t; }
      }
      return best;
    };
    if (active.length > 0) return mapSecretaryActivity((pickNewest(active) as any)?.status);
    const clar = owned.filter((s) => String((s as any).status) === "needs-clarification");
    if (clar.length > 0) return mapSecretaryActivity((pickNewest(clar) as any)?.status);
    return mapSecretaryActivity((pickNewest(owned) as any)?.status);
  } catch { return null; }
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
  originRevision?: string;
  live?: boolean;
}

export function useMeetingActivity(inp: MeetingActivityInput) {
  const [rev, setRev] = useState(0);
  const originRev = (inp as any)?.originRevision ?? "";
  const queryEnabled = !!inp.boardId && !!inp.meetingId && inp.boardValid && inp.meetingValid && !inp.sessGate && inp.tab === "meet";
  const q = useQuery({
    queryKey: ["activity", inp.boardId, inp.meetingId, originRev],
    queryFn: () => inp.get<any>("/api/meetings/" + inp.meetingId + "/activity"),
    enabled: queryEnabled,
    refetchInterval: 4000,
    retry: false,
  });
  useEffect(() => { try { setRev((v: number) => v + 1); } catch {} }, [inp.boardId, inp.meetingId, originRev]);
  const reqOriginRef = useRef<any>(null);
  const reqKeyRef = useRef<string>("");
  useEffect(() => {
    try {
      const key = String(inp.boardId) + "|" + String(inp.meetingId) + "|" + String(originRev);
      if (!inp.boardId || !inp.meetingId) return;
      if (reqKeyRef.current === key && reqOriginRef.current) return;
      reqKeyRef.current = key;
      try { reqOriginRef.current = inp.originOf(); } catch { reqOriginRef.current = null; }
    } catch {}
  }, [inp.boardId, inp.meetingId, originRev]);
  const reqStale = (() => {
    try {
      const o = reqOriginRef.current;
      if (!o) return false;
      return !!inp.isOriginStale(o);
    } catch { return true; }
  })();
  const fetchFailed = hasActivityFetchFailed(q as any);
  const hasData = !!(q as any)?.data;
  const isPaused = (() => {
    try {
      if ((q as any)?.isPaused) return true;
      if (String((q as any)?.fetchStatus ?? "") === "paused") return true;
      return false;
    } catch { return false; }
  })();
  const liveOff = (inp as any)?.live === false;
  const isLoading = (() => {
    try {
      if ((q as any)?.isLoading) return true;
      if ((q as any)?.isFetching && !hasData) return true;
      return false;
    } catch { return false; }
  })();
  const activityAvailability = resolveActivityAvailability({ reqStale, fetchFailed, queryEnabled, hasData, isPaused, liveOff, isLoading });
  const snapshotUsable = activityAvailability === "available" && shouldUseActivitySnapshot({ reqStale, fetchFailed });
  const advisorSnapshot = useMemo(() => {
    const m = new Map<string, string>();
    try {
      if (!snapshotUsable) return m;
      const snap: any = (q as any)?.data;
      if (!snap || !inp.boardId || !inp.meetingId) return m;
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
  }, [(q as any)?.data, (q as any)?.error, (q as any)?.isError, rev, inp.boardId, inp.meetingId, originRev, snapshotUsable]);
  const secretaryActivity = useMemo(() => {
    try {
      if (!snapshotUsable) return null;
      const snap: any = (q as any)?.data;
      if (!snap || !inp.boardId || !inp.meetingId) return null;
      const secs: any[] = (snap as any)?.secretary ?? [];
      return selectSecretaryActivity(secs);
    } catch { return null; }
  }, [(q as any)?.data, (q as any)?.error, (q as any)?.isError, rev, inp.boardId, inp.meetingId, originRev, snapshotUsable]);
  return { advisorSnapshot, secretaryActivity, activityData: snapshotUsable ? ((q as any)?.data ?? null) : null, activityAvailability, activityLoading: activityAvailability === "loading", activityPaused: activityAvailability === "paused", activityUnavailable: activityAvailability === "unavailable" };
}
