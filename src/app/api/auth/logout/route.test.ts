import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ clearSession: vi.fn() }));
import { clearSession } from "@/lib/auth";
import { POST } from "./route";

describe("logout behind a forwarding proxy", () => {
  it("clears the session and returns to login on the browser's origin", async () => {
    const response = await POST();
    expect(clearSession).toHaveBeenCalledOnce();
    expect(response.status).toBe(303);
    const browserUrl = "https://example-3000.app.github.dev/api/auth/logout";
    expect(new URL(response.headers.get("location")!, browserUrl).href)
      .toBe("https://example-3000.app.github.dev/login");
  });
});
