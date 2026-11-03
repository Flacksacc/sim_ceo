export const VOICE_TARGET_RATE = 16000;
export const VOICE_MAX_SECONDS = 300;
export const VOICE_MAX_DECODE_SECONDS = 310;
export const VOICE_CONVERT_TIMEOUT_MS = 30000;
export const VOICE_SUPPORTED_RATES = [16000, 24000] as const;

export function encodeWavMono16(samples: Float32Array<ArrayBufferLike>, sampleRate: number): Uint8Array {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const writeAscii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeAscii(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    let s = samples[i];
    if (!Number.isFinite(s)) s = 0;
    s = Math.max(-1, Math.min(1, s));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

export function downmixToMono(channels: Float32Array<ArrayBufferLike>[]): Float32Array<ArrayBuffer> {
  if (channels.length === 0) throw new Error("No audio captured.");
  if (channels.length === 1) return (channels[0] as Float32Array<ArrayBuffer>).slice() as Float32Array<ArrayBuffer>;
  const n = Math.min(...channels.map((c) => c.length));
  if (!Number.isFinite(n) || n <= 0) throw new Error("No audio captured.");
  const out = new Float32Array(n);
  const k = channels.length;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < k; c++) {
      const v = channels[c][i];
      s += Number.isFinite(v) ? v : 0;
    }
    out[i] = s / k;
  }
  return out as Float32Array<ArrayBuffer>;
}

export function isAbortError(e: unknown, signal?: AbortSignal | null): boolean {
  if (signal && signal.aborted) return true;
  return e instanceof DOMException && e.name === "AbortError";
}

export function cancelError(): Error {
  return new DOMException("Voice conversion cancelled.", "AbortError");
}

export function timeoutError(): Error {
  return new Error("Voice conversion timed out; try a shorter recording.");
}

export async function convertRecordedBlobToWav(
  blob: Blob,
  targetRate: number = VOICE_TARGET_RATE,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ wavBytes: Uint8Array; wavBlob: Blob; durationSec: number; sampleRate: number }> {
  const signal = opts?.signal;
  const totalMs = opts?.timeoutMs ?? VOICE_CONVERT_TIMEOUT_MS;
  if (signal && signal.aborted) throw cancelError();
  if (!blob || blob.size === 0) throw new Error("No audio captured.");
  if (blob.size > 10 * 1024 * 1024) throw new Error("Recording exceeds 10 MB before conversion.");
  if (!Number.isFinite(targetRate) || (targetRate !== 16000 && targetRate !== 24000))
    throw new Error("Unsupported voice target rate.");
  const AC: typeof AudioContext | undefined =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) throw new Error("Audio conversion unavailable in this browser.");
  // ONE total deadline for the whole conversion: blob read + decode + render.
  // A single master timer bounds every stage. Terminal cleanup is idempotent
  // and bounded: the owned context is closed at most once and the close is
  // never awaited, so a pending native close cannot retain the public
  // conversion promise past the deadline or caller cancellation. Stage abort
  // listeners are tracked and removed on every terminal path, the owned
  // rendering source is disconnected on both abort and timeout, and the first
  // terminal reason (cancel vs timeout) is preserved for late completions.
  let settled = false;
  let ac: AudioContext | null = null;
  let renderSrc: { disconnect: () => void } | null = null;
  let timer: number | null = null;
  let closeStarted = false;
  let terminalReason: string | null = null;
  const stageAborts = new Set<() => void>();
  const stageRemovers = new Set<() => void>();
  const removeAllStage = () => {
    const fns = Array.from(stageRemovers);
    stageRemovers.clear();
    stageAborts.clear();
    for (const fn of fns) {
      try { fn(); } catch { /* ignore */ }
    }
  };
  const disconnectRender = () => {
    const s = renderSrc;
    renderSrc = null;
    if (s) {
      try { s.disconnect(); } catch { /* ignore */ }
    }
  };
  const closeOnce = () => {
    if (closeStarted) return;
    closeStarted = true;
    const c = ac;
    ac = null;
    if (!c) return;
    try {
      const r = c.close() as unknown as Promise<void> | void;
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
    } catch { /* ignore */ }
  };
  let terminalDone = false;
  const terminal = (reason: string | null) => {
    if (terminalReason === null && reason !== null) terminalReason = reason;
    if (terminalDone) return;
    terminalDone = true;
    removeAllStage();
    disconnectRender();
    if (timer !== null) { try { window.clearTimeout(timer); } catch { /* ignore */ } timer = null; }
    if (signal) signal.removeEventListener("abort", onAbortCleanup);
    closeOnce();
  };
  const onAbortCleanup = () => {
    if (settled) return;
    settled = true;
    // Fire active stage rejectors first so no gated promise is stranded
    // pending (which would hang the public promise when the master timer
    // later observes settled and stays inert).
    const fns = Array.from(stageAborts);
    stageAborts.clear();
    for (const fn of fns) {
      try { fn(); } catch { /* ignore */ }
    }
    terminal("cancel");
  };
  if (signal) signal.addEventListener("abort", onAbortCleanup, { once: true });
  const timeoutGate = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      terminal("timeout");
      reject(timeoutError());
    }, totalMs);
  });
  timeoutGate.catch(() => {});
  const gate = <T>(p: Promise<T>, onStageAbort?: () => void): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      if (settled) { reject(terminalReason === "timeout" ? timeoutError() : cancelError()); return; }
      if (signal && signal.aborted) { reject(cancelError()); return; }
      const ab = () => {
        try { onStageAbort && onStageAbort(); } catch { /* ignore */ }
        stageAborts.delete(ab);
        if (!settled) { settled = true; terminal("cancel"); }
        remove();
        reject(cancelError());
      };
      const remove = () => {
        if (signal) signal.removeEventListener("abort", ab);
        stageRemovers.delete(remove);
        stageAborts.delete(ab);
      };
      stageRemovers.add(remove);
      stageAborts.add(ab);
      if (signal) signal.addEventListener("abort", ab, { once: true });
      p.then(
        (v) => { remove(); if (settled) return; resolve(v); },
        (e) => { remove(); if (settled) return; reject(e); },
      );
    });
  };
  const raced = <T>(p: Promise<T>, onStageAbort?: () => void): Promise<T> =>
    Promise.race([gate(p, onStageAbort), timeoutGate]);
  try {
    const raw = new Uint8Array(await raced(blob.arrayBuffer()));
    if (raw.length === 0) throw new Error("No audio captured.");
    ac = new AC();
    const thisAc = ac;
    let decoded: AudioBuffer;
    try {
      const copy = raw.slice().buffer as ArrayBuffer;
      decoded = await raced(thisAc.decodeAudioData(copy));
    } catch (e) {
      if (terminalReason === "timeout") throw timeoutError();
      if (terminalReason === "cancel" || (signal && signal.aborted) || isAbortError(e, signal)) throw cancelError();
      if (settled) throw timeoutError();
      throw new Error("Could not decode recording; try again.");
    }
    let wavBytes: Uint8Array;
    let wavBlob: Blob;
    let durSec = 0;
    try {
      if (!decoded || decoded.length === 0) throw new Error("No audio captured.");
      const decodedSec = decoded.duration;
      if (!Number.isFinite(decodedSec) || decodedSec <= 0) throw new Error("No audio captured.");
      if (decodedSec > VOICE_MAX_DECODE_SECONDS) throw new Error("Recording too long (max 5 minutes).");
      const nCh = decoded.numberOfChannels;
      if (!Number.isFinite(nCh) || nCh < 1 || nCh > 32) throw new Error("Unsupported audio channels.");
      const parts: Float32Array<ArrayBufferLike>[] = [];
      for (let c = 0; c < nCh; c++) parts.push(decoded.getChannelData(c));
      let mono: Float32Array<ArrayBuffer>;
      try {
        mono = downmixToMono(parts);
      } catch {
        throw new Error("No audio captured.");
      }
      const ratio = targetRate / decoded.sampleRate;
      if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 8) throw new Error("Unsupported voice target rate.");
      const targetLen = Math.max(1, Math.floor(mono.length * ratio));
      if (!Number.isFinite(targetLen) || targetLen <= 0) throw new Error("No audio captured.");
      if (targetLen / targetRate > VOICE_MAX_DECODE_SECONDS) throw new Error("Recording too long (max 5 minutes).");
      if (targetLen > VOICE_MAX_DECODE_SECONDS * 24000 + 1024) throw new Error("Recording too long (max 5 minutes).");
      const srcBuf = thisAc.createBuffer(1, mono.length, decoded.sampleRate);
      srcBuf.getChannelData(0).set(mono);
      const off = new OfflineAudioContext(1, targetLen, targetRate);
      const src = off.createBufferSource();
      renderSrc = src;
      src.buffer = srcBuf;
      src.connect(off.destination);
      src.start(0);
      let rendered: AudioBuffer;
      try {
        rendered = await raced(off.startRendering(), () => { disconnectRender(); });
      } catch (e) {
        if (terminalReason === "timeout") throw timeoutError();
        if (terminalReason === "cancel" || (signal && signal.aborted) || isAbortError(e, signal)) throw cancelError();
        if (settled) throw timeoutError();
        throw e;
      }
      renderSrc = null;
      const out = rendered.getChannelData(0).slice();
      durSec = out.length / targetRate;
      if (durSec <= 0) throw new Error("No audio captured.");
      if (durSec > VOICE_MAX_SECONDS) throw new Error("Recording too long (max 5 minutes).");
      wavBytes = encodeWavMono16(out, targetRate);
      if (wavBytes.length > 10 * 1024 * 1024) throw new Error("Converted audio exceeds 10 MB.");
      wavBlob = new Blob([wavBytes.buffer as ArrayBuffer], { type: "audio/wav" });
    } finally {
      // Bounded terminal close: fire once, never awaited, so pending native
      // cleanup cannot retain the public promise. terminal() also removes
      // stage listeners and disconnects the render source on abort/timeout.
      if (ac === thisAc) terminal(null);
    }
    if (settled) throw terminalReason === "cancel" ? cancelError() : timeoutError();
    settled = true;
    terminal(null);
    return { wavBytes: wavBytes!, wavBlob: wavBlob!, durationSec: durSec, sampleRate: targetRate };
  } catch (e) {
    if (!settled) {
      settled = true;
      terminal("error");
    }
    throw e;
  }
}