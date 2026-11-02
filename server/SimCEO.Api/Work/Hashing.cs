using System.Security.Cryptography;
using System.Text;

namespace SimCEO.Api.Work;

public static class Hashing
{
  public static string HashOf(string s) =>
    Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant()[..16];

  public static string FullHash(byte[] bytes) =>
    Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
