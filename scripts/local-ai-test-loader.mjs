// Never use this loader in the product. The provider class below has no network.
import "./local-ts-loader.mjs";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "openai") return nextResolve(new URL("./synthetic-openai.mjs", import.meta.url).href, context);
  return nextResolve(specifier, context);
} });
