const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function must(cond, msg) { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } else { console.log("ok: " + msg); } }
function read(rel) { return fs.readFileSync(path.join(root, rel), "utf8"); }
// 1. Server helper uses shared actual RosterOps resolution, read-only, identical order (dbb).
const disp = read("server/SimCEO.Api/Work/RosterDisplayPortrait.cs");
must(disp.includes("RosterOps.ResolveSelectedImage"), "display uses shared ResolveSelectedImage");
must(disp.includes("RosterOps.IsPortraitAccepted"), "display uses shared IsPortraitAccepted");
must(disp.includes("RosterOps.HasExplicitPortraitSelection"), "display uses shared HasExplicitPortraitSelection");
must(disp.includes(".OrderBy(i => i.CreatedAt).ThenBy(i => i.Id)"), "display legacy order CreatedAt Then Id");
must(disp.includes("if (sel.RosterEntryId != a.RosterEntryId) return null"), "display enforces same-roster identity");
must(!disp.includes("Approved =") && !disp.includes("ImageProvenance ="), "display performs no persistent mutation");
const roster = read("server/SimCEO.Api/Work/RosterEndpoints.cs");
must(roster.includes(".OrderBy(i => i.CreatedAt).ThenBy(i => i.Id)"), "fingerprint/gate legacy order present");
must(roster.includes("public static AdvisorImage? ResolveSelectedImage"), "shared resolver present");
must(roster.includes("public static string ReviewedPortraitFingerprint"), "fingerprint present");
must(roster.includes("public static string? ApprovalGate"), "approval gate present");
const orderCount = (roster.match(/\.OrderBy\(i => i\.CreatedAt\)\.ThenBy\(i => i\.Id\)/g) || []).length;
must(orderCount >= 2, "fingerprint and gate share deterministic legacy order");
must(disp.includes("return RosterOps.IsPortraitAccepted(sel) ? sel : null"), "explicit valid accepted wins, pending stays fallback");
must(disp.includes("if (RosterOps.HasExplicitPortraitSelection(a)) return null"), "explicit invalid/ambiguous stays fallback, no rescue");
// 2. Advisors DTO: retain canonical roster projection + additive display id only, single resolve.
const prog = read("server/SimCEO.Api/Program.cs");
must(prog.includes("ResolveCanonicalView"), "manager retains canonical ResolveCanonicalView");
must(prog.includes("rosterName ="), "manager retains rosterName");
must(prog.includes("rosterVersionCurrent ="), "manager retains rosterVersionCurrent");
must(prog.includes("behaviorFingerprint ="), "manager retains behaviorFingerprint");
must(prog.includes("displayPortraitImageId = (Guid?)displayId"), "manager adds display id to canonical projection");
must(prog.includes("var guestDisplayId = RosterDisplayOps.ResolveDisplayPortrait(s, a)?.Id"), "guest computes display id once");
must(!prog.includes("ResolveDisplayPortrait(s, a) == null ? (Guid?)null : RosterDisplayOps.ResolveDisplayPortrait(s, a)!.Id"), "no double resolve with possible NRE window");
must(prog.includes("PeopleOps.BadToken(s, req)"), "BadToken guard retained");
must(!prog.includes("<<<<<<<") && !prog.includes(">>>>>>>"), "no merge markers remain");
// 3. Frontend helpers: precise GUID groups; compile actual meeting-presence.ts and test real exports.
const mpSrc = read("web/src/meeting-presence.ts");
must(mpSrc.includes("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"), "display id validates precise GUID groups");
const web = path.join(root, "web");
const out = path.join(root, ".presence-tmp");
try { fs.rmSync(out, { recursive: true, force: true }); } catch {}
execSync("npx tsc src/meeting-presence.ts --outDir " + JSON.stringify(path.relative(web, out)) + " --module commonjs --target es2020 --jsx react-jsx --moduleResolution node --skipLibCheck", { cwd: web, stdio: "inherit" });
const mp = require(path.join(out, "meeting-presence.js"));
must(typeof mp.normalizeDisplayImageId === "function", "normalizeDisplayImageId exported");
must(mp.normalizeDisplayImageId("  12345678-1234-1234-1234-1234567890ab  ") === "12345678-1234-1234-1234-1234567890ab", "valid GUID passes through trimmed");
must(mp.normalizeDisplayImageId(null) === null, "null stays fallback");
must(mp.normalizeDisplayImageId("") === null, "empty stays fallback");
must(mp.normalizeDisplayImageId("not-a-guid") === null, "non-GUID never loads");
must(mp.normalizeDisplayImageId("12345678") === null, "legacy 8-char alone never loads as display id");
must(mp.normalizeDisplayImageId("12345678-1234-1234-1234-1234567890") === null, "truncated GUID never loads");
must(typeof mp.isPortraitAccepted === "function", "acceptance helper preserved");
must(mp.isPortraitAccepted("accepted") === true, "accepted loads");
must(mp.isPortraitAccepted("grandfathered") === true, "grandfathered loads");
must(mp.isPortraitAccepted("rejected") === false, "rejected stays fallback");
must(mp.isPortraitAccepted("pending") === false, "pending stays fallback");
const gid = "12345678-1234-1234-1234-1234567890ab";
const parts = mp.provenanceParts("upload:" + gid);
must(parts.guid && parts.guid.toLowerCase() === gid, "provenance GUID split");
must(mp.resolveProvenanceImage(parts, [{ id: gid, review: "accepted" }]) === gid, "selected accepted resolves");
must(mp.resolveProvenanceImage(parts, [{ id: gid, review: "rejected" }]) === null, "selected rejected stays fallback, no rescue");
must(mp.buildPresence({ leadName: "Lead", leadRoleLabel: "Board lead", advisors: [{ id: "a1", boardRole: "Ops", approved: true, portraitUrl: "blob:xyz" }], includedIds: [] }).find((s) => s.key === "a1").portraitUrl === "blob:xyz", "display portraitUrl flows to seat");
// 4. App hook: fail-closed fresh authoritative DTO before bytes (no cached rescue).
const app = read("web/src/App.tsx");
must(app.includes("function useDisplayPortraits(boardId: string,"), "hook takes boardId for fresh DTO");
must(app.includes("/api/boards/${boardId}/advisors"), "focus re-queries authoritative advisors DTO");
must(app.includes("freshByKey"), "fresh display map built before bytes");
must(!app.includes("fallback to cached"), "no cached-metadata rescue text remains");
must(!app.includes("freshByKey.has(e.key) ? freshByKey.get(e.key) : e.displayImageId"), "omitted advisor is not rescued from cached props");
must(app.includes("if (!freshByKey.has(e.key)) continue"), "omitted advisor stays fallback");
must(app.includes("if (!Array.isArray(fresh)) return"), "malformed DTO stays fallback");
must(app.includes("if (!boardId) return"), "missing board stays fallback without request");
must(app.includes("if (!live || retired() || freshList === null) return"), "failed fresh DTO keeps initials, no request after retired");
must(app.includes("const id = normalizeDisplayImageId(raw ?? null)"), "only valid fresh display id loads");
must(app.includes("if (!id) continue"), "null fresh metadata stays fallback");
must(app.includes("useDisplayPortraits(boardId, presenceEntries"), "presence uses fresh hook with boardId");
must(app.includes("currentToken()") && app.includes("currentUser()") && app.includes("epochNow()"), "token/user/epoch guards preserved");
must(app.includes("window.addEventListener(\"focus\"") && app.includes("visibilitychange"), "focus/visibility revalidation preserved");
must(app.includes("URL.revokeObjectURL"), "no hidden stale URL reuse, blobs revoked");
must(app.includes("blobStale(b)"), "exact bytes via authedBlobUrl, stale discarded");
must(app.includes("portraitRev") && app.includes("advisorsTick"), "review revocation and advisor refresh bump key");
try { fs.rmSync(out, { recursive: true, force: true }); } catch {}
// 5. Real in-process C# probe against REAL RosterDisplayOps (no mirrored logic, no HTTP/PG).
execSync("dotnet run --project qa/PresenceDisplayProbe", { cwd: root, stdio: "inherit", env: { ...process.env, USE_POSTGRES: "0" } });
console.log("advisor-presence-portrait: PASS");
