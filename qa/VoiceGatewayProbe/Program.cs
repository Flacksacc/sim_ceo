using System.Net.Http.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Work;

var fake = Environment.GetEnvironmentVariable("QA_FAKE") ?? "http://127.0.0.1:5206";
var failures = new List<string>();
void Check(bool ok, string name, string detail = "") {
  Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);
  if (!ok) failures.Add(name);
}
static byte[] MakeWav(int rate, double seconds, double freq = 440) {
  int n = (int)(rate * seconds);
  var buf = new byte[44 + n * 2];
  void W(int o, string s) { for (int i = 0; i < s.Length; i++) buf[o + i] = (byte)s[i]; }
  W(0, "RIFF"); BitConverter.GetBytes((uint)(36 + n * 2)).CopyTo(buf, 4); W(8, "WAVE");
  W(12, "fmt "); BitConverter.GetBytes((uint)16).CopyTo(buf, 16);
  BitConverter.GetBytes((ushort)1).CopyTo(buf, 20); BitConverter.GetBytes((ushort)1).CopyTo(buf, 22);
  BitConverter.GetBytes((uint)rate).CopyTo(buf, 24); BitConverter.GetBytes((uint)(rate * 2)).CopyTo(buf, 28);
  BitConverter.GetBytes((ushort)2).CopyTo(buf, 32); BitConverter.GetBytes((ushort)16).CopyTo(buf, 34);
  W(36, "data"); BitConverter.GetBytes(n * 2).CopyTo(buf, 40);
  for (int i = 0; i < n; i++) {
    short s = (short)Math.Round(32767 * 0.5 * Math.Sin(2 * Math.PI * freq * i / rate));
    BitConverter.GetBytes(s).CopyTo(buf, 44 + i * 2);
  }
  return buf;
}
static byte[] WithRiffDelta(byte[] src, int delta) {
  var b = (byte[])src.Clone();
  uint v = BitConverter.ToUInt32(b, 4);
  uint nv = unchecked((uint)((long)v + delta)); BitConverter.GetBytes(nv).CopyTo(b, 4);
  return b;
}
using var http = new HttpClient();
async Task<int> FakeTranscribes() {
  try {
    var j = await http.GetFromJsonAsync<Dictionary<string, int>>(fake + "/__counts");
    return j != null && j.TryGetValue("transcribe", out var v) ? v : -1;
  } catch { return -1; }
}
var store = new InMemoryStore();
var gw = new ModelGateway(store);
Environment.SetEnvironmentVariable("META_API_KEY", "qa-dummy");

var good16 = MakeWav(16000, 0.5);
var good24 = MakeWav(24000, 0.5);
Check(VoiceAudio.TryValidate(good16, "audio/wav", "mic.wav", out _, out _, out _, out _), "gateway-valid16-validate");
Check(VoiceAudio.TryValidate(good24, "audio/wav", "note.wav", out _, out _, out _, out _), "gateway-valid24-validate");

var badRiff = (byte[])good16.Clone(); badRiff[0] = (byte)88;
var trunc = good16[..20];
var floatWav = (byte[])good16.Clone(); BitConverter.GetBytes((ushort)3).CopyTo(floatWav, 20);
var stereo = (byte[])good16.Clone(); BitConverter.GetBytes((ushort)2).CopyTo(stereo, 22);
var rate8k = (byte[])good16.Clone(); BitConverter.GetBytes((uint)8000).CopyTo(rate8k, 24);
var odd = (byte[])good16.Clone(); { uint ds = BitConverter.ToUInt32(odd, 40); BitConverter.GetBytes(ds - 1).CopyTo(odd, 40); }
var webm = System.Text.Encoding.ASCII.GetBytes("this is not wav");
var empty = Array.Empty<byte>();
var corrupt = (byte[])good16.Clone(); BitConverter.GetBytes((uint)0xFFFFFF).CopyTo(corrupt, 16);
var big = new byte[10 * 1024 * 1024 + 1];
var riffMinus = WithRiffDelta(good16, -1);
var riffPlus = WithRiffDelta(good16, 1);
byte[] trailingBad = null!;
{ var extra = System.Text.Encoding.ASCII.GetBytes("BAD"); trailingBad = new byte[good16.Length + 3]; good16.CopyTo(trailingBad, 0); extra.CopyTo(trailingBad, good16.Length); BitConverter.GetBytes((uint)(trailingBad.Length - 8)).CopyTo(trailingBad, 4); }
byte[] junkNoPad = null!;
{ int di = Array.IndexOf(good16, (byte)100); var dataIdx = System.Text.Encoding.ASCII.GetString(good16, 12, good16.Length - 12).IndexOf("data") + 12; var head = good16[..dataIdx]; var data = good16[dataIdx..]; var junk = new byte[9]; System.Text.Encoding.ASCII.GetBytes("JUNK").CopyTo(junk, 0); BitConverter.GetBytes((uint)1).CopyTo(junk, 4); junk[8] = 65; junkNoPad = new byte[head.Length + junk.Length + data.Length]; head.CopyTo(junkNoPad, 0); junk.CopyTo(junkNoPad, head.Length); data.CopyTo(junkNoPad, head.Length + junk.Length); BitConverter.GetBytes((uint)(junkNoPad.Length - 8)).CopyTo(junkNoPad, 4); }
byte[] dupData = null!;
{ var dup = new byte[10]; System.Text.Encoding.ASCII.GetBytes("data").CopyTo(dup, 0); BitConverter.GetBytes(2).CopyTo(dup, 4); dupData = new byte[good16.Length + 10]; good16.CopyTo(dupData, 0); dup.CopyTo(dupData, good16.Length); BitConverter.GetBytes((uint)(dupData.Length - 8)).CopyTo(dupData, 4); }
byte[] dupFmt = null!;
{ var fmt = good16[12..36]; var head = good16[..12]; var rest = good16[36..]; dupFmt = new byte[head.Length + fmt.Length * 2 + rest.Length]; head.CopyTo(dupFmt, 0); fmt.CopyTo(dupFmt, head.Length); fmt.CopyTo(dupFmt, head.Length + fmt.Length); rest.CopyTo(dupFmt, head.Length + fmt.Length * 2); BitConverter.GetBytes((uint)(dupFmt.Length - 8)).CopyTo(dupFmt, 4); }

var invalids = new (string name, byte[] buf)[] {
  ("bad-riff", badRiff), ("truncated", trunc), ("float-fmt", floatWav), ("stereo", stereo),
  ("rate-8k", rate8k), ("odd-data", odd), ("webm-bytes", webm), ("empty", empty),
  ("chunk-bounds", corrupt), ("oversize", big), ("riff-minus-1", riffMinus), ("riff-plus-1", riffPlus),
  ("trailing-bad", trailingBad), ("junk-missing-pad", junkNoPad), ("dup-data", dupData), ("dup-fmt", dupFmt),
};
foreach (var (name, buf) in invalids) {
  bool okv = VoiceAudio.TryValidate(buf, "audio/wav", "mic.wav", out var err, out _, out _, out _);
  Check(!okv, "gateway-" + name + "-validate", err);
  int c0 = await FakeTranscribes();
  int u0 = store.Usage.Count();
  int m0 = store.ModelCalls.Count();
  bool threwVoice = false;
  try { await gw.TranscribeAsync(buf, "audio/wav", "mic.wav"); }
  catch (VoiceAudioException) { threwVoice = true; }
  catch (Exception ex) { Check(false, "gateway-" + name + "-voicetype", ex.GetType().Name); continue; }
  Check(threwVoice, "gateway-" + name + "-throws-voice", "threwVoice=" + threwVoice);
  int c1 = await FakeTranscribes();
  Check(c0 >= 0 && c1 == c0, "gateway-" + name + "-no-provider", c0 + "->" + c1);
  Check(store.Usage.Count() == u0, "gateway-" + name + "-no-usage", u0 + "->" + store.Usage.Count());
  Check(store.ModelCalls.Count() == m0, "gateway-" + name + "-no-model-calls", m0 + "->" + store.ModelCalls.Count());
}
// 300s + 1 frame (frame-exact bound before ms floor)
{
  int sr = 16000; int n = sr * 300 + 1;
  var buf = new byte[44 + n * 2];
  void W(int o, string s) { for (int i = 0; i < s.Length; i++) buf[o + i] = (byte)s[i]; }
  W(0, "RIFF"); BitConverter.GetBytes((uint)(36 + n * 2)).CopyTo(buf, 4); W(8, "WAVE");
  W(12, "fmt "); BitConverter.GetBytes((uint)16).CopyTo(buf, 16);
  BitConverter.GetBytes((ushort)1).CopyTo(buf, 20); BitConverter.GetBytes((ushort)1).CopyTo(buf, 22);
  BitConverter.GetBytes((uint)sr).CopyTo(buf, 24); BitConverter.GetBytes((uint)(sr * 2)).CopyTo(buf, 28);
  BitConverter.GetBytes((ushort)2).CopyTo(buf, 32); BitConverter.GetBytes((ushort)16).CopyTo(buf, 34);
  W(36, "data"); BitConverter.GetBytes(n * 2).CopyTo(buf, 40);
  bool okv = VoiceAudio.TryValidate(buf, "audio/wav", "mic.wav", out var err, out _, out _, out _);
  Check(!okv, "gateway-maxdur-plus-1-validate", err);
  int c0 = await FakeTranscribes();
  int u0 = store.Usage.Count();
  int m0 = store.ModelCalls.Count();
  bool threw = false;
  try { await gw.TranscribeAsync(buf, "audio/wav", "mic.wav"); } catch (VoiceAudioException) { threw = true; }
  Check(threw, "gateway-maxdur-plus-1-throws");
  int c1 = await FakeTranscribes();
  Check(c1 == c0, "gateway-maxdur-plus-1-no-provider", c0 + "->" + c1);
  Check(store.Usage.Count() == u0, "gateway-maxdur-plus-1-no-usage", u0 + "->" + store.Usage.Count());
  Check(store.ModelCalls.Count() == m0, "gateway-maxdur-plus-1-no-model-calls", m0 + "->" + store.ModelCalls.Count());
}
// valid 16k gateway attempt hits provider exactly once with metering
{
  int c0 = await FakeTranscribes();
  int u0 = store.Usage.Count();
  int m0 = store.ModelCalls.Count();
  var (tx, _) = await gw.TranscribeAsync(good16, "audio/wav", "mic.wav", ownerOverride: true);
  Check(tx == "qa transcript", "gateway-valid-transcript", tx);
  int c1 = await FakeTranscribes();
  Check(c1 == c0 + 1, "gateway-valid-provider-hit", c0 + "->" + c1);
  Check(store.Usage.Count() == u0 + 1, "gateway-valid-usage-hit", u0 + "->" + store.Usage.Count());
  Check(store.ModelCalls.Count() == m0 + 1, "gateway-valid-calls-hit", m0 + "->" + store.ModelCalls.Count());
}
// valid 24k gateway positive with metering
{
  int c0 = await FakeTranscribes();
  int u0 = store.Usage.Count();
  int m0 = store.ModelCalls.Count();
  var (tx24, _) = await gw.TranscribeAsync(good24, "audio/wav", "note.wav", ownerOverride: true);
  Check(tx24 == "qa transcript", "gateway-valid24-transcript", tx24);
  int c1 = await FakeTranscribes();
  Check(c1 == c0 + 1, "gateway-valid24-provider-hit", c0 + "->" + c1);
  Check(store.Usage.Count() == u0 + 1, "gateway-valid24-usage-hit", u0 + "->" + store.Usage.Count());
  Check(store.ModelCalls.Count() == m0 + 1, "gateway-valid24-calls-hit", m0 + "->" + store.ModelCalls.Count());
}
Console.WriteLine(failures.Count == 0 ? "VOICEGATEWAY PASS" : "VOICEGATEWAY FAIL " + failures.Count);
foreach (var f in failures) Console.WriteLine(" - " + f);
return failures.Count == 0 ? 0 : 1;

