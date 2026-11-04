const { execSync, execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

// Behavioral frontend checks for the feedback-integration workstream.
// Compiles web/src/__behavioral__/check.tsx plus the real components it
// imports, renders them to HTML with react-dom/server, and asserts on
// rendered behavior (labels, gating, honest statuses, human-first copy).
// This exercises rendered output, not file existence or raw strings.
const root = path.resolve(__dirname, "..");
const web = path.join(root, "web");
const out = path.join(root, ".beh-tmp");
try {
  fs.rmSync(out, { recursive: true, force: true });
  execSync(
    "npx tsc src/__behavioral__/check.tsx --outDir " + path.join("..", ".beh-tmp") +
    " --module commonjs --target es2020 --jsx react-jsx --esModuleInterop --skipLibCheck --moduleResolution node",
    { cwd: web, stdio: "inherit" },
  );
  const dropCss = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) dropCss(p);
      else if (f.name.endsWith(".js")) {
        const t = fs.readFileSync(p, "utf8");
        if (t.indexOf(".css") >= 0) fs.writeFileSync(p, t.split("\n").filter((ln) => ln.indexOf(".css") < 0).join("\n"));
      }
    }
  };
  dropCss(out);
  const childOut = execFileSync(
    process.execPath,
    [path.join(out, "__behavioral__", "check.js")],
    { env: Object.assign({}, process.env, { NODE_PATH: path.join(web, "node_modules") }), encoding: "utf8" },
  );
  process.stdout.write(childOut);
  console.log("frontend-integration-behavioral: PASS");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
