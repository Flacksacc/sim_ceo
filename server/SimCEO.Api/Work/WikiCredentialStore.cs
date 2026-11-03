using Microsoft.AspNetCore.DataProtection;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Server-held Wiki credential via ASP.NET Data Protection with a stable private
// file-system keyring (Windows DPAPI protection where available). Public DTOs
// and backups expose only HasCredential; the token never appears in logs,
// error text, ordinary state, localStorage, or exports. Restored metadata
// carries no credential. QA uses its own isolated .tmp keyring, never the
// user's default keyring.
public sealed class WikiCredentialStore
{
  private readonly IDataProtector _protector;
  private readonly InMemoryStore _store;

  public WikiCredentialStore(IDataProtectionProvider provider, InMemoryStore store)
  {
    _protector = provider.CreateProtector("wiki-resource-token.v1");
    _store = store;
  }

  public void SetToken(Guid resourceId, string token)
  {
    var protected_ = _protector.Protect(token);
    if (_store.WikiSecrets.TryGetValue(resourceId, out var sec))
    {
      sec.ProtectedToken = protected_;
      sec.UpdatedAt = DateTime.UtcNow;
    }
    else
    {
      sec = new WikiResourceSecret { Id = resourceId, ResourceId = resourceId, ProtectedToken = protected_, UpdatedAt = DateTime.UtcNow };
      _store.WikiSecrets[resourceId] = sec;
    }
    try { _store.WikiSecrets.Flush(); } catch { }
  }

  public string? GetToken(Guid resourceId)
  {
    if (!_store.WikiSecrets.TryGetValue(resourceId, out var sec)) return null;
    if (string.IsNullOrEmpty(sec.ProtectedToken)) return null;
    try { return _protector.Unprotect(sec.ProtectedToken); }
    catch { return null; }
  }

  public void ClearToken(Guid resourceId)
  {
    if (_store.WikiSecrets.TryRemove(resourceId, out _)) { try { _store.WikiSecrets.Flush(); } catch { } }
  }

  public bool HasToken(Guid resourceId)
    => _store.WikiSecrets.TryGetValue(resourceId, out var sec) && !string.IsNullOrEmpty(sec.ProtectedToken);
}
