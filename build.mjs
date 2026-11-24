// Builds dist/mercado-recovery-<version>.html: one self-contained file (no outside scripts), plus its SHA-256.
// The build is deterministic for a given source, lockfile and esbuild version, so anyone can rebuild and compare.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const out = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  write: false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
// The page allows exactly this script, by its SHA-256 (no 'unsafe-inline'): if anything injected a script into the
// page, the browser would refuse to run it (final re-check, A).
const scriptHash = `sha256-${createHash("sha256").update(js).digest("base64")}`;
const html = readFileSync("src/page.html", "utf8").replace("__VERSION__", version).replace("__SCRIPT_HASH__", scriptHash)
  .replace("<script>__SCRIPT__</script>", () => `<script>${js}</script>`);
if (!html.includes(`script-src '${scriptHash}'`)) throw new Error("CSP hash not placed");
mkdirSync("dist", { recursive: true });
const file = `dist/mercado-recovery-${version}.html`;
writeFileSync(file, html);
const sha = createHash("sha256").update(html).digest("hex");
writeFileSync(`${file}.sha256`, `${sha}  mercado-recovery-${version}.html\n`);
console.log(file, `${(html.length / 1024).toFixed(0)} KB`, "sha256", sha);
