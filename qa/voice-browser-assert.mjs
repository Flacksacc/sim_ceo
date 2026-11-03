// Authoritative browser assertion predicates for voice QA. The browser suite
// AND the counterexample suite both import these, so negative controls feed
// hostile inputs to the ACTUAL assertions instead of separate copied logic.
export function draftStrictEquals(actual, expected) {
  return actual === expected;
}
export function transcriptAppended(draft, origin) {
  return draft === origin + " qa transcript";
}
export function staleWriteAbsent(draft, origin) {
  return draft === origin;
}
export function payloadShaMatches(capturedHex, providerHex) {
  return capturedHex === providerHex;
}
export function payloadBytesMatch(capturedLen, providerLen) {
  return capturedLen === providerLen;
}
export async function waitForCount(getCount, baseline, label, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const cc = await getCount();
    if (cc.transcribe > baseline) return cc;
    if (Date.now() - t0 > (timeoutMs || 30000)) {
      throw new Error(label + " timed out waiting for fresh provider hit; base=" + baseline + " cur=" + JSON.stringify(cc));
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}