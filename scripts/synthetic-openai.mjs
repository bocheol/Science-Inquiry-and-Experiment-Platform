export default class SyntheticOpenAI {
  static APIError = class extends Error {};
  static APIConnectionError = class extends Error {};
  responses = {
    create: input => this.generate("chat", input),
    parse: input => this.generate("topic", input),
  };
  generate(kind, input) {
    if (typeof globalThis.__syntheticOpenAI !== "function") throw new Error("Synthetic AI generator is not configured");
    return globalThis.__syntheticOpenAI(kind, input);
  }
}
