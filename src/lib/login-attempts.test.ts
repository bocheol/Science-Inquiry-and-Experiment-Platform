import { describe, expect, it } from "vitest";
import {
  clearLoginAttempts,
  getLoginAttemptState,
  LOGIN_ATTEMPT_POLICY,
  loginAttemptBucketKey,
  recordFailedLogin,
} from "@/lib/login-attempts";

describe("login attempt throttling", () => {
  it("temporarily limits one account and network pair, then recovers after expiry", async () => {
    const key = loginAttemptBucketKey("throttle-student", "203.0.113.10");
    await clearLoginAttempts(key);
    const start = new Date("2026-09-07T00:00:00.000Z");

    for (let attempt = 1; attempt < LOGIN_ATTEMPT_POLICY.maxFailures; attempt += 1) {
      const state = await recordFailedLogin(key, new Date(start.getTime() + attempt * 1000));
      expect(state.blocked).toBe(false);
      expect(state.failureCount).toBe(attempt);
    }
    const blockedAt = new Date(start.getTime() + LOGIN_ATTEMPT_POLICY.maxFailures * 1000);
    const blocked = await recordFailedLogin(key, blockedAt);
    expect(blocked.blocked).toBe(true);
    expect(blocked.failureCount).toBe(LOGIN_ATTEMPT_POLICY.maxFailures);

    const recoveredAt = new Date(blockedAt.getTime() + LOGIN_ATTEMPT_POLICY.blockDurationMs + 1);
    expect((await getLoginAttemptState(key, recoveredAt)).blocked).toBe(false);
    const restarted = await recordFailedLogin(key, recoveredAt);
    expect(restarted).toMatchObject({ blocked: false, failureCount: 1 });
  });

  it("does not block another student sharing the same school network", async () => {
    const network = "203.0.113.20";
    const firstKey = loginAttemptBucketKey("shared-network-a", network);
    const secondKey = loginAttemptBucketKey("shared-network-b", network);
    expect(firstKey).not.toBe(secondKey);
    await clearLoginAttempts(firstKey);
    await clearLoginAttempts(secondKey);
    const now = new Date("2026-09-07T01:00:00.000Z");
    for (let attempt = 0; attempt < LOGIN_ATTEMPT_POLICY.maxFailures; attempt += 1) {
      await recordFailedLogin(firstKey, new Date(now.getTime() + attempt));
    }
    expect((await getLoginAttemptState(firstKey, now)).blocked).toBe(true);
    expect((await getLoginAttemptState(secondKey, now)).blocked).toBe(false);
  });
});
