import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

describe("installable web app manifest", () => {
  it("opens the signed-in destination in a standalone app window", () => {
    const value = manifest();

    expect(value.name).toBe("과탐실 AI 탐구 플랫폼");
    expect(value.start_url).toBe("/");
    expect(value.scope).toBe("/");
    expect(value.display).toBe("standalone");
  });

  it("provides standard and maskable installation icons", () => {
    const icons = manifest().icons ?? [];

    expect(icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "192x192", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
      ]),
    );
  });
});
