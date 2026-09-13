import { readdir, readFile } from "node:fs/promises";
import { expect, it } from "vitest";

async function routes(path: URL): Promise<URL[]> {
  const result: URL[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, path);
    if (entry.isDirectory()) result.push(...await routes(child));
    else if (entry.name === "route.ts") result.push(child);
  }
  return result;
}

it("uses the bounded reader for every Route Handler that parses JSON", async () => {
  const api = new URL("../app/api/", import.meta.url);
  const unbounded: string[] = [];
  for (const file of await routes(api)) {
    const source = await readFile(file, "utf8");
    if (/\brequest\.json\(/.test(source)) unbounded.push(file.pathname);
  }
  expect(unbounded).toEqual([]);
});
