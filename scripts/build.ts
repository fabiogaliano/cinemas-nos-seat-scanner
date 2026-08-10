import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outdir = join(root, "dist");
const version = crypto.randomUUID().slice(0, 8);
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src/client/app.tsx")],
  outdir,
  target: "browser",
  minify: true,
  sourcemap: "external",
  naming: "app.[ext]",
  define: { "process.env.NODE_ENV": '"production"', __BUILD_VERSION__: JSON.stringify(version) },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await cp(join(root, "public"), outdir, { recursive: true });

const indexPath = join(outdir, "index.html");
const index = await readFile(indexPath, "utf8");
await writeFile(indexPath, index.replaceAll("__BUILD_VERSION__", version));
