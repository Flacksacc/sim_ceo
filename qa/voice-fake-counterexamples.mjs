import crypto from "node:crypto";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5206";
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function last() {
  const r = await fetch(FAKE + "/__last-transcribe");
  const j = await r.json();
  if (r.status !== 200 || !j || typeof j.n !== "number") throw new Error("fake last shape invalid");
  return j;
}
function makeWav(sr, seconds, freq) {
  const n = Math.floor(sr * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(32767 * 0.5 * Math.sin((2 * Math.PI * freq * i) / sr)), 44 + i * 2);
  return buf;
}
// Counterexample 1: tone hidden in JUNK, actual data silent.
// Old stats (first "data" substring anywhere) reported tone RMS; the real
// data chunk is silent, so faithful stats must be silent.
{
  const sr = 16000;
  const tone = makeWav(sr, 0.5, 440);
  const tonePayload = tone.subarray(44);
  const junkSize = tonePayload.length;
  const junk = Buffer.alloc(8 + junkSize + 4 + ((junkSize + 4) % 2));
  junk.write("JUNK", 0); junk.writeUInt32LE(junkSize + 4, 4);
  junk.set(Buffer.from("data"), 8);
  tonePayload.copy(junk, 12);
  const fmt = tone.subarray(12, 36);
  const silent = Buffer.alloc(44 + 8000 * 2);
  silent.write("RIFF", 0); silent.writeUInt32LE(36 + 8000 * 2, 4); silent.write("WAVE", 8);
  fmt.copy(silent, 12);
  silent.write("data", 36); silent.writeUInt32LE(8000 * 2, 40);
  const body = Buffer.concat([silent.subarray(0, 12), junk, silent.subarray(12)]);
  body.writeUInt32LE(body.length - 8, 4);
  const form = new FormData();
  form.append("audio", new Blob([body], { type: "audio/wav" }), "mic.wav");
  const r = await fetch(FAKE + "/asr/transcribe", { method: "POST", body: form });
  ok("junk-tone-accepted", r.status === 200, String(r.status));
  const l = await last();
  ok("junk-tone-valid", l.validWav === true, JSON.stringify(l).slice(0, 200));
  ok("junk-tone-silent-rms", l.rms === 0, "rms=" + l.rms);
  ok("junk-tone-silent-nz", l.nz === 0, "nz=" + l.nz);
  ok("junk-tone-dsize", l.dataBytes === 8000 * 2, String(l.dataBytes));
}
// Counterexample 2: audio bytes contain a bare boundary string without CRLF
// framing. Old splitting truncated the part; legal-framing parse must keep
// exact bytes and hash.
{
  const boundary = "TESTBOUNDARY123";
  const wav = makeWav(16000, 0.5, 440);
  const needle = Buffer.from("--" + boundary, "ascii");
  wav.set([0, 0], 1000);
  needle.copy(wav, 1002);
  wav.set([0, 0], 1002 + needle.length);
  const reqJson = Buffer.from(JSON.stringify({ model: "m", audioEncoding: "WAV" }), "utf8");
  const head1 = Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"request\"\r\nContent-Type: application/json\r\n\r\n", "latin1");
  const head2 = Buffer.from("\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"mic.wav\"\r\nContent-Type: audio/wav\r\n\r\n", "latin1");
  const tail = Buffer.from("\r\n--" + boundary + "--\r\n", "latin1");
  const rawBody = Buffer.concat([head1, reqJson, head2, wav, tail]);
  const r = await fetch(FAKE + "/asr/transcribe", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=" + boundary },
    body: rawBody,
  });
  ok("bare-boundary-accepted", r.status === 200, String(r.status));
  const l = await last();
  const want = crypto.createHash("sha256").update(wav).digest("hex").slice(0, 16);
  ok("bare-boundary-valid", l.validWav === true, JSON.stringify(l).slice(0, 200));
  ok("bare-boundary-bytes", l.audioBytes === wav.length, l.audioBytes + " vs " + wav.length);
  ok("bare-boundary-sha", l.audioSha256 === want, l.audioSha256 + " vs " + want);
}
// Sanity: plain valid WAV still fully valid.
{
  const wav = makeWav(16000, 0.5, 440);
  const form = new FormData();
  form.append("audio", new Blob([wav], { type: "audio/wav" }), "mic.wav");
  const r = await fetch(FAKE + "/asr/transcribe", { method: "POST", body: form });
  ok("sane-accepted", r.status === 200, String(r.status));
  const l = await last();
  ok("sane-valid", l.validWav === true && l.rms > 1000 && l.nz > 1000, JSON.stringify(l).slice(0, 200));
}
console.log(fail === 0 ? "VOICEFAKECX PASS " + pass : "VOICEFAKECX FAIL pass=" + pass + " fail=" + fail);
for (const f of failures) console.log(" - " + f);
process.exitCode = fail === 0 ? 0 : 1;
