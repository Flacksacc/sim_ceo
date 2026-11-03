using SimCEO.Api.Work;

var failures = new System.Collections.Generic.List<string>();
void Check(bool ok, string name, string detail)
{
  System.Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);
  if (!ok) failures.Add(name);
}
bool StructOk(string url, bool expect)
{
  var ok = PublicEvidenceFetcher.IsStructureAllowed(new Uri(url), out var reason);
  return ok == expect;
}
Check(StructOk("https://example.com/a.png", true), "public-https-allowed", "reason-checked");
Check(StructOk("http://example.com:8080/a.png", false), "odd-port-rejected", "non-80/443 must fail");
Check(StructOk("http://localhost/a.png", false), "localhost-rejected", "");
Check(StructOk("http://127.0.0.1/a.png", false), "loopback-literal-rejected", "");
Check(StructOk("http://[::ffff:127.0.0.1]/a.png", false), "mapped-ipv4-rejected", "IPv4-mapped IPv6 must fail");
Check(StructOk("http://10.0.0.5/a.png", false), "private-v4-rejected", "");
Check(StructOk("http://user:pw@example.com/a.png", false), "userinfo-rejected", "");
Check(StructOk("ftp://example.com/a.png", false), "scheme-rejected", "");
byte[] png = new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00 };
byte[] jpg = new byte[] { 0xFF, 0xD8, 0xFF, 0xE0, 0x00 };
byte[] gif = System.Text.Encoding.ASCII.GetBytes("GIF89aXXXX");
byte[] webp = new byte[] { (byte)'R', (byte)'I', (byte)'F', (byte)'F', 0, 0, 0, 0, (byte)'W', (byte)'E', (byte)'B', (byte)'P' };
byte[] bmp = new byte[] { (byte)'B', (byte)'M', 0, 0 };
byte[] txt = System.Text.Encoding.ASCII.GetBytes("this is not an image at all, just text");
byte[] trunc = new byte[] { 0x89, 0x50 };
Check(PublicImageFetcher.HasRasterMagic(png), "magic-png", "");
Check(PublicImageFetcher.HasRasterMagic(jpg), "magic-jpeg", "");
Check(PublicImageFetcher.HasRasterMagic(gif), "magic-gif", "");
Check(PublicImageFetcher.HasRasterMagic(webp), "magic-webp", "");
Check(PublicImageFetcher.HasRasterMagic(bmp), "magic-bmp", "");
Check(!PublicImageFetcher.HasRasterMagic(txt), "magic-text-rejected", "");
Check(!PublicImageFetcher.HasRasterMagic(trunc), "magic-truncated-rejected", "");
Check(!PublicImageFetcher.HasRasterMagic(Array.Empty<byte>()), "magic-empty-rejected", "");
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
var priv = await PublicImageFetcher.FetchRasterAsync("http://127.0.0.1:9/nope.png", cts.Token);
Check(priv.Data is null, "private-fetch-no-request", "loopback must fail closed without sending");
var bad = await PublicImageFetcher.FetchRasterAsync("not a url", cts.Token);
Check(bad.Data is null, "malformed-url-rejected", "");
System.Console.WriteLine(failures.Count == 0 ? "PROBE RESULT: PASS" : "PROBE RESULT: FAIL (" + failures.Count + ")");
return failures.Count == 0 ? 0 : 1;
