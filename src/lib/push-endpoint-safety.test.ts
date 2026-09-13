import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { assertSafePushDestination, isSafePushEndpoint, savePushSubscription } from "@/lib/push-notifications";
import type { SessionUser } from "@/lib/types";

const student: SessionUser = {
  id: "demo_student_1",
  name: "푸시주소검증학생",
  loginId: "10901",
  role: "student",
  academicYear: 2026,
  classId: "class_2026_9",
  classNumber: 9,
  mustChangePassword: false,
};

describe("push endpoint safety", () => {
  it.each([
    "http://push.example/subscription",
    "https://localhost/subscription",
    "https://device.internal/subscription",
    "https://printer.local/subscription",
    "https://127.0.0.1/subscription",
    "https://10.20.30.40/subscription",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/subscription",
    "https://[fd00::1234]/subscription",
    "https://user:password@push.example/subscription",
  ])("rejects a local or private destination: %s", (endpoint) => {
    expect(isSafePushEndpoint(endpoint)).toBe(false);
  });

  it("accepts a normal HTTPS push provider endpoint", () => {
    expect(isSafePushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/example-token")).toBe(true);
    expect(isSafePushEndpoint("https://fcm.googleapis.com/fcm/send/example-token?mode=webpush")).toBe(true);
  });

  it("rejects a public-looking hostname when DNS resolves it to a private address", async () => {
    await expect(assertSafePushDestination(
      "https://push-provider.example/subscription",
      async () => ["10.0.0.25"],
    )).rejects.toThrow("안전한");
    await expect(assertSafePushDestination(
      "https://push-provider.example/subscription",
      async () => ["2001:4860:4860::8888"],
    )).resolves.toBeUndefined();
  });

  it("rejects an unsafe endpoint before storing it", async () => {
    await expect(savePushSubscription(student, {
      endpoint: "https://192.168.0.10/push",
      keys: { p256dh: "p".repeat(80), auth: "a".repeat(24) },
    })).rejects.toThrow("안전한");
    const db = await getDb();
    const stored = await db.query("SELECT id FROM push_subscriptions WHERE endpoint = 'https://192.168.0.10/push'");
    expect(stored.rows).toHaveLength(0);
  });
});
