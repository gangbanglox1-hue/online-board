// Bundles src/worker.js for Node: pages are inlined as text, `cloudflare:workers` comes from the shim.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
await build({
  entryPoints: [path.join(root, "src/worker.js")],
  outfile: path.join(root, "node/dist/worker.mjs"),
  bundle: true, format: "esm", platform: "node", target: "node22",
  external: ["node:*", "ws"],
  plugins: [{
    name: "board",
    setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: path.join(root, "node/shim.mjs") }));
      b.onLoad({ filter: /[\\/]public[\\/][^\\/]+\.(html|svg|js)$/ }, a => ({ contents: fs.readFileSync(a.path, "utf8"), loader: "text" }));
    },
  }],
  logLevel: "warning",
});
console.log("built node/dist/worker.mjs");
