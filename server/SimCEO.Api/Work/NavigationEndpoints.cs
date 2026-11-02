using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api;

// Navigation selected-entity lookups. Bounded list endpoints cap their
// windows (boards 100, meetings 200, records 50), so absence from a list
// never establishes deletion. These scoped singular lookups confirm the
// route context instead: 404 (or a parent mismatch, also 404) is the only
// authoritative signal that clears a selected id. Read permission matches
// the other meeting reads; downstream queries wait for a verified parent.
public static class NavigationEndpoints
{
  public static void MapNavigation(this WebApplication app)
  {
    app.MapGet("/api/boards/{bid:guid}/meetings/{mid:guid}", (InMemoryStore s, HttpRequest req, Guid bid, Guid mid) =>
    {
      if (!s.Meetings.TryGetValue(mid, out var m) || m.BoardId != bid) return Results.NotFound();
      if (!PeopleOps.Can(s, req, m.BoardId, mid, "read")) return PeopleOps.Denied();
      return Results.Ok(m);
    });
  }
}
