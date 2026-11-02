using Microsoft.AspNetCore.SignalR;

namespace SimCEO.Api.Hubs;

public sealed class BoardHub : Hub
{
  public Task JoinBoard(string boardId) => Groups.AddToGroupAsync(Context.ConnectionId, $"board:{boardId}");
  public Task JoinMeeting(string meetingId) => Groups.AddToGroupAsync(Context.ConnectionId, $"meeting:{meetingId}");
}
