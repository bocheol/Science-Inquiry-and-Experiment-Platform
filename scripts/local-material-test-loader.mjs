// Verification only: sheet transport is replaced before the real material service loads.
import "./local-ts-loader.mjs";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/material-sheet-transfer") return nextResolve(new URL("./synthetic-material-transfer.mjs", import.meta.url).href, context);
  return nextResolve(specifier, context);
} });
