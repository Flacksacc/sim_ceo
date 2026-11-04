export async function readAdvisorStream<T>(response: Response, onText: (text: string) => void, fresh: () => void): Promise<T> {
  fresh();
  if (!response.ok) throw Object.assign(new Error(`${response.status} ${await response.text()}`), { status: response.status });
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const value = await response.json(); fresh(); return value as T;
  }
  if (!response.body) throw new Error("No response stream was received.");
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = "", kind = "", data = "", result: T | undefined, completed = false;
  function event() {
    if (!data) return;
    const value = JSON.parse(data); fresh();
    if (kind === "delta" && typeof value.text === "string" && value.text.length <= 65536) onText(value.text);
    if (kind === "done") { result = value as T; completed = true; }
    if (kind === "error") throw Object.assign(new Error(`${value.status ?? 502} ${value.error ?? "Response interrupted."}`), { status: value.status });
    data = ""; kind = "";
  }
  try {
    while (true) {
      const chunk = await reader.read(); fresh();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 262144) throw new Error("Response stream exceeded its limit.");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, ""); buffer = buffer.slice(index + 1);
        if (!line) event(); else if (line.startsWith("event:")) kind = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trimStart();
      }
    }
    if (!completed) throw new Error("The advisor response was interrupted. Please retry.");
    return result!;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
