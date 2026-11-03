using System.Text;

namespace SimCEO.Api.Work;

// Bounded server-side WAV gate for voice transcribe.
// Official Meta FILE speech-to-text requires RIFF/WAVE mono 16-bit PCM at
// 16kHz or 24kHz. The browser converts before upload, but the server must
// reject unsupported/malformed/empty/oversized audio BEFORE any provider
// attempt so rejected local input is never billed and never touches Usage.
// Strict: exact RIFF length, complete padded consumption, single fmt/data,
// consistent alignment, frame-exact 5-minute bound checked before ms floor.
public sealed class VoiceAudioException(string message) : Exception(message);

public static class VoiceAudio
{
  public const int MaxBytes = 10 * 1024 * 1024;
  // 16kHz mono 16-bit = 32000 bytes/sec + 44 header; 5 min ~= 9.6 MB.
  public const int MaxSeconds = 300;
  public static readonly int[] ValidRates = [16000, 24000];

  public static bool TryValidate(byte[] audio, string? contentType, string? fileName,
    out string error, out int durationMs, out string normalizedContentType, out string normalizedFileName)
  {
    error = "";
    durationMs = 0;
    normalizedContentType = "audio/wav";
    var baseName = string.IsNullOrWhiteSpace(fileName) ? "mic" : fileName.Trim();
    var dot = baseName.LastIndexOf((char)46);
    var stem = dot > 0 ? baseName.Substring(0, dot) : baseName;
    if (string.IsNullOrWhiteSpace(stem)) stem = "mic";
    normalizedFileName = stem + ".wav";
    if (audio is null || audio.Length == 0) { error = "No audio."; return false; }
    if (audio.Length > MaxBytes) { error = "Audio exceeds 10 MB."; return false; }
    if (audio.Length < 44) { error = "Unsupported audio: expected RIFF/WAVE mono 16-bit PCM 16k/24k WAV."; return false; }
    if (audio[0] != (byte)82 || audio[1] != (byte)73 || audio[2] != (byte)70 || audio[3] != (byte)70) { error = "Unsupported audio: expected RIFF/WAVE mono 16-bit PCM 16k/24k WAV."; return false; }
    if (audio[8] != (byte)87 || audio[9] != (byte)65 || audio[10] != (byte)86 || audio[11] != (byte)69) { error = "Unsupported audio: expected RIFF/WAVE mono 16-bit PCM 16k/24k WAV."; return false; }
    // Exact RIFF container length: no +-1 tolerance.
    try
    {
      uint riffSize = BitConverter.ToUInt32(audio, 4);
      long expected = (long)audio.Length - 8;
      if (riffSize != expected) { error = "Unsupported audio: corrupt WAV chunk bounds."; return false; }
    }
    catch { error = "Unsupported audio: corrupt WAV chunk bounds."; return false; }
    bool fmtFound = false;
    bool dataFound = false;
    ushort audioFormat = 0;
    ushort channels = 0;
    uint sampleRate = 0;
    ushort bits = 0;
    int dataSize = 0;
    int off = 12;
    try
    {
      while (off + 8 <= audio.Length)
      {
        string id = Encoding.ASCII.GetString(audio, off, 4);
        uint size = BitConverter.ToUInt32(audio, off + 4);
        long total = 8L + size + (size % 2);
        // Padded chunk bounds: payload plus pad byte (when odd) must fit.
        if (size > int.MaxValue || off + total > audio.Length) { error = "Unsupported audio: corrupt WAV chunk bounds."; return false; }
        // Payload itself must fit (pad-aware total check above also covers it).
        if (off + 8L + size > audio.Length) { error = "Unsupported audio: corrupt WAV chunk bounds."; return false; }
        if (id == "fmt ")
        {
          if (fmtFound) { error = "Unsupported audio: ambiguous WAV structure (duplicate fmt)."; return false; }
          if (size < 16) { error = "Unsupported audio: corrupt WAV chunk bounds."; return false; }
          audioFormat = BitConverter.ToUInt16(audio, off + 8);
          channels = BitConverter.ToUInt16(audio, off + 10);
          sampleRate = BitConverter.ToUInt32(audio, off + 12);
          uint byteRate = BitConverter.ToUInt32(audio, off + 16);
          ushort blockAlign = BitConverter.ToUInt16(audio, off + 20);
          bits = BitConverter.ToUInt16(audio, off + 22);
          if (audioFormat != 1) { error = "Unsupported audio: WAV must be PCM 16-bit mono 16k/24k."; return false; }
          if (channels != 1) { error = "Unsupported audio: WAV must be mono 16-bit PCM 16k/24k."; return false; }
          bool rateOk = false;
          foreach (var r in ValidRates) if (sampleRate == r) rateOk = true;
          if (!rateOk) { error = "Unsupported audio: WAV sample rate must be 16000 or 24000 Hz."; return false; }
          if (bits != 16) { error = "Unsupported audio: WAV must be 16-bit PCM mono 16k/24k."; return false; }
          ushort expectAlign = (ushort)(channels * (bits / 8));
          uint expectRate = sampleRate * expectAlign;
          if (blockAlign != expectAlign || byteRate != expectRate) { error = "Unsupported audio: corrupt WAV format block alignment."; return false; }
          fmtFound = true;
        }
        else if (id == "data")
        {
          if (dataFound) { error = "Unsupported audio: ambiguous WAV structure (duplicate data)."; return false; }
          dataFound = true;
          dataSize = (int)size;
          if (dataSize == 0) { error = "No audio."; return false; }
          if (dataSize % 2 != 0) { error = "Unsupported audio: corrupt WAV data bounds (odd bytes for 16-bit PCM)."; return false; }
        }
        // Unknown chunks (e.g. LIST, fact, bext) are skipped with padding when
        // unambiguous; they do not affect duration.
        off += (int)total;
      }
    }
    catch (VoiceAudioException) { throw; }
    catch { error = "Unsupported audio: corrupt WAV chunk bounds."; return false; }
    // Complete consumption: no ignored trailing bytes and no trailing chunk
    // fragment smaller than a header.
    if (off != audio.Length) { error = "Unsupported audio: corrupt WAV chunk bounds."; return false; }
    if (!fmtFound || !dataFound) { error = "Unsupported audio: expected RIFF/WAVE mono 16-bit PCM 16k/24k WAV."; return false; }
    long bytesPerSec = (long)sampleRate * 2;
    // Frame-exact bound BEFORE millisecond floor: 300s + 1 frame must reject
    // even when floor would round it down to 300000 ms.
    long frames = (long)dataSize / 2L;
    long maxFrames = (long)MaxSeconds * sampleRate;
    if (frames <= 0) { error = "No audio."; return false; }
    if (frames > maxFrames) { error = "Audio exceeds 5 minutes at 16k mono PCM."; return false; }
    long ms = frames * 1000L / sampleRate;
    if (ms <= 0) { error = "No audio."; return false; }
    if (ms > (long)MaxSeconds * 1000L) { error = "Audio exceeds 5 minutes at 16k mono PCM."; return false; }
    if (dataSize > MaxBytes) { error = "Audio exceeds 10 MB."; return false; }
    if (bytesPerSec <= 0) { error = "Unsupported audio: corrupt WAV chunk bounds."; return false; }
    durationMs = (int)ms;
    return true;
  }
}
