// Verification-only resolver for native Node TypeScript execution of app services.
import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
registerHooks({ resolve(specifier, context, nextResolve) {
  let candidate;
  if (specifier.startsWith("@/")) candidate = path.join(sourceRoot, specifier.slice(2));
  else if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts")) candidate = fileURLToPath(new URL(specifier, context.parentURL));
  if (candidate) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) candidate = path.join(candidate, "index.ts");
    else if (!existsSync(candidate) && existsSync(candidate + ".ts")) candidate += ".ts";
    return nextResolve(pathToFileURL(candidate).href, context);
  }
  return nextResolve(specifier, context);
} });
