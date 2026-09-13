import "./local-ts-loader.mjs";
import { registerHooks } from "node:module";
// Native Node needs explicit extensions for these Next entry points. The real
// exports remain intact; this test calls password updates, not request cookies.
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(["next/headers", "next/navigation"].includes(specifier) ? `${specifier}.js` : specifier, context);
} });
