import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const project = new URL("../", import.meta.url);
async function walk(relative) {
  const files = [];
  for (const entry of await readdir(new URL(relative, project), { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.name === "route.ts") files.push(path);
  }
  return files;
}
const routes = [];
for (const path of (await walk("src/app/api")).sort()) {
  const source = await readFile(new URL(path, project), "utf8");
  const jsonReads = [], broadErrors = [];
  source.split(/\r?\n/).forEach((line, index) => {
    if (/\b(?:request|req)\.json\(/.test(line)) jsonReads.push(index + 1);
    if (/instanceof Error[^\n]*\.message/.test(line)) broadErrors.push(index + 1);
  });
  routes.push({ path, sha256: createHash("sha256").update(source).digest("hex"), jsonReads, broadErrors });
}
const result = {
  date: "2026-09-09", scope: "Static candidate inventory; not a runtime exploit or complete call-graph audit",
  routeCount: routes.length,
  jsonRouteCount: routes.filter(row => row.jsonReads.length).length,
  broadErrorRouteCount: routes.filter(row => row.broadErrors.length).length,
  routes,
};
const outputName = process.argv[2] ?? "security-surface-current.json";
if (!/^security-surface-[a-z0-9-]+\.json$/.test(outputName)) throw new Error("Invalid output name");
await writeFile(new URL(`output/test-infra/${outputName}`, project), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ routeCount: result.routeCount, jsonRouteCount: result.jsonRouteCount, broadErrorRouteCount: result.broadErrorRouteCount }));
