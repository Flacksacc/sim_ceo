using System.Runtime.InteropServices;
using SkiaSharp;

// Strict raster validation via bounded actual codec decode (Phase 9 seventh repair).
// Pinned MIT packages (ordinary dependency, not paid service):
// - SkiaSharp 4.154.0 (https://www.nuget.org/packages/SkiaSharp/4.154.0, MIT https://github.com/mono/SkiaSharp/blob/main/LICENSE.md)
// - SkiaSharp.NativeAssets.Linux.NoDependencies 4.154.0 (https://www.nuget.org/packages/SkiaSharp.NativeAssets.Linux.NoDependencies/4.154.0)
// Codec-only from in-memory bytes, no filepaths/URLs/network. Header CreateCodec is not decoding:
// require GetPixels result Success (https://learn.microsoft.com/en-us/dotnet/api/skiasharp.skcodec.getpixels?view=skiasharp-3.119).
// Whitelist PNG/JPEG/WebP only. Bound encoded bytes 8MiB (existing per-image cap) + decode budget 64MiB
// (16M 32-bit pixels) checked BEFORE allocation. Disposes codec/data per unit, no retained buffers.
// Preserves original return bytes unchanged. Unsupported/oversized decode => false (unknown, never billed).
// Still images only: FrameCount must be 1, animated ANMF rejected as unsupported (no header-only false success).
public static class ImageValidation
{
  private static bool SaneDecodeDims(long w, long h) =>
    w >= 1 && h >= 1 && w <= 16384 && h <= 16384 && w * h <= 16_000_000L;

  private static bool ValidateWithCodec(byte[] b, SKEncodedImageFormat want)
  {
    try
    {
      if (b == null || b.Length < 16) return false;
      if (b.Length > 8 * 1024 * 1024) return false;
      using var data = SKData.CreateCopy(b);
      if (data == null) return false;
      using var codec = SKCodec.Create(data);
      if (codec == null) return false;
      if (codec.EncodedFormat != want) return false;
      var w = (long)codec.Info.Width;
      var h = (long)codec.Info.Height;
      if (!SaneDecodeDims(w, h)) return false;
      if (codec.FrameCount > 1) return false;
      long pixelCount = w * h;
      if (pixelCount < 1 || pixelCount > 16_000_000L) return false;
      long byteCount = pixelCount * 4L;
      if (byteCount < 1 || byteCount > 64L * 1024L * 1024L) return false;
      var dstInfo = new SKImageInfo((int)w, (int)h, SKColorType.Bgra8888, SKAlphaType.Premul);
      var pixels = new byte[(int)byteCount];
      var handle = GCHandle.Alloc(pixels, GCHandleType.Pinned);
      try
      {
        var result = codec.GetPixels(dstInfo, handle.AddrOfPinnedObject());
        if (result != SKCodecResult.Success) return false;
      }
      finally
      {
        if (handle.IsAllocated) handle.Free();
      }
      return true;
    }
    catch { return false; }
  }

  public static bool IsPngStrict(byte[] b) => ValidateWithCodec(b, SKEncodedImageFormat.Png);

  public static bool IsJpegStrict(byte[] b) => ValidateWithCodec(b, SKEncodedImageFormat.Jpeg);

  public static bool IsWebPStrict(byte[] b) => ValidateWithCodec(b, SKEncodedImageFormat.Webp);
}