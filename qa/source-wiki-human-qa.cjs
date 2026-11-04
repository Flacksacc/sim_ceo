const { execSync, execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

// Source-only human UI checks for SourcesGovernance + WikiResources.
// Compiles source-wiki-human-check.tsx plus the real components it imports,
// renders them to HTML with react-dom/server, and asserts rendered behavior
// (visible copy, accessible names, retained action wiring). No servers, no
// production data, no network, no browser. The owned headless loopback run
// stays with the primary acceptance pass.
const root = path.resolve(__dirname, "..");
const web = path.join(root, "web");
const out = path.join(root, ".tmp", "source-wiki-human-check");
try {
  fs.rmSync(out, { recursive: true, force: true });
} catch {}
fs.mkdirSync(out, { recursive: true });
execSync(
  "npx tsc source-wiki-human-check.tsx --outDir ../.tmp/source-wiki-human-check" +
  " --module commonjs --target es2020 --jsx react-jsx --esModuleInterop --skipLibCheck --moduleResolution node",
  { cwd: web, stdio: "inherit" },
);
const childOut = execFileSync(
  process.execPath,
  [path.join(out, "source-wiki-human-check.js")],
  { env: Object.assign({}, process.env, { NODE_PATH: path.join(web, "node_modules") }), encoding: "utf8" },
);
process.stdout.write(childOut);
console.log("source-wiki-human-qa: PASS");
