// qa/sigsub.mjs - isolated SignalR event capture child for meeting-activity QA.
// Spawned by meeting-activity-qa.mjs (own child). Usage:
//   node qa/sigsub.mjs <api> <token> <meetingCsv> <outfile> <durationMs>
// Records every meeting-activity / secretary-activity / run-complete / message
// frame plus join/connect outcomes as JSON lines. Exits alone after durationMs.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(process.cwd() + "/qa/.sigclient/");
const { HubConnectionBuilder, LogLevel } = require("@microsoft/signalr");

const [api, token, meetingsCsv, outfile, durationMs] = process.argv.slice(2);
// Incremental append (truncate at start): the orchestrator may poll this file
// for __connected/__joined markers BEFORE triggering traffic, and a missing
// file must read as absent rather than as an empty success.
try { fs.writeFileSync(outfile, ""); } catch { }
const emit = (entry) => { try { fs.appendFileSync(outfile, JSON.stringify(entry) + "\n"); } catch { } };
const conn = new HubConnectionBuilder()
  .withUrl(api + "/hubs/board?access_token=" + encodeURIComponent(token || ""))
  .configureLogging(LogLevel.Warning)
  .build();
for (const m of ["meeting-activity", "secretary-activity", "run-complete", "message"]) {
  conn.on(m, (payload) => { emit({ t: Date.now(), method: m, payload }); });
}
const note = (kind, info) => { emit({ t: Date.now(), method: "__" + kind, payload: info }); };
try {
  await conn.start();
  note("connected", {});
  for (const mid of (meetingsCsv || "").split(",").filter(Boolean)) {
    try { await conn.invoke("JoinMeeting", mid); note("joined", { meeting: mid }); }
    catch (e) { note("join-failed", { meeting: mid, error: String((e && e.message) || e) }); }
  }
  await new Promise((r) => setTimeout(r, Number(durationMs) || 30000));
} catch (e) { note("connect-failed", { error: String((e && e.message) || e) }); }
try { await conn.stop(); } catch { }
process.exit(0);
