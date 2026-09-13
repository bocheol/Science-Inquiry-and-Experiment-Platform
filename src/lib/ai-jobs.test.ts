import { describe, expect, it, vi } from "vitest";
import { aiRequestKey, beginAiJob, completeAiJob, failAiJob, runAiJobStep } from "@/lib/ai-jobs";
import { getDb } from "@/lib/db";

describe("recoverable AI jobs", () => {
  it("reuses a completed result and permits only the lease owner to complete", async () => {
    const requestKey = aiRequestKey("lease-test", { value: 1 });
    const first = await beginAiJob<{ answer: string }>({
      resourceKey: "ai-test:completed",
      requestKey,
      feature: "lease-test",
      actorId: "teacher_bootstrap",
    });
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") return;
    const db = await getDb();
    expect(await completeAiJob(db, first.jobId, "wrong-owner", { answer: "wrong" })).toBe(false);
    expect(await completeAiJob(db, first.jobId, first.leaseToken, { answer: "saved" })).toBe(true);
    const cached = await beginAiJob<{ answer: string }>({
      resourceKey: "ai-test:completed", requestKey, feature: "lease-test", actorId: "teacher_bootstrap",
    });
    expect(cached).toMatchObject({ kind: "cached", result: { answer: "saved" } });
  });

  it("recovers an expired lease without letting the old owner overwrite it", async () => {
    const requestKey = aiRequestKey("expiry-test", { value: 2 });
    const start = new Date("2026-09-07T02:00:00.000Z");
    const oldLease = await beginAiJob<{ answer: string }>({
      resourceKey: "ai-test:expiry", requestKey, feature: "expiry-test", actorId: "teacher_bootstrap", leaseMs: 1000, now: start,
    });
    expect(oldLease.kind).toBe("acquired");
    const active = await beginAiJob({
      resourceKey: "ai-test:expiry", requestKey, feature: "expiry-test", actorId: "teacher_bootstrap", leaseMs: 1000,
      now: new Date(start.getTime() + 500),
    });
    expect(active.kind).toBe("busy");
    const replacement = await beginAiJob<{ answer: string }>({
      resourceKey: "ai-test:expiry", requestKey, feature: "expiry-test", actorId: "teacher_bootstrap", leaseMs: 1000,
      now: new Date(start.getTime() + 1001),
    });
    expect(replacement.kind).toBe("acquired");
    if (oldLease.kind !== "acquired" || replacement.kind !== "acquired") return;
    const db = await getDb();
    expect(await completeAiJob(db, oldLease.jobId, oldLease.leaseToken, { answer: "stale" })).toBe(false);
    expect(await completeAiJob(db, replacement.jobId, replacement.leaseToken, { answer: "current" })).toBe(true);
  });

  it("keeps finished generation steps when a later step fails and the job is retried", async () => {
    const requestKey = aiRequestKey("step-test", { value: 3 });
    const first = await beginAiJob({
      resourceKey: "ai-test:steps", requestKey, feature: "step-test", actorId: "teacher_bootstrap",
    });
    if (first.kind !== "acquired") throw new Error("lease missing");
    const generator = vi.fn().mockResolvedValue({ questions: ["kept"] });
    expect(await runAiJobStep(first, "common", generator)).toEqual({ questions: ["kept"] });
    await failAiJob(first.jobId, first.leaseToken);
    const retry = await beginAiJob({
      resourceKey: "ai-test:steps", requestKey, feature: "step-test", actorId: "teacher_bootstrap",
    });
    if (retry.kind !== "acquired") throw new Error("retry lease missing");
    expect(await runAiJobStep(retry, "common", generator)).toEqual({ questions: ["kept"] });
    expect(generator).toHaveBeenCalledTimes(1);
  });

  it("retires an expired different request on the same resource before accepting late writes", async () => {
    const start = new Date("2026-09-08T01:00:00Z");
    const common = { resourceKey: "ai-test:different-request", feature: "synthetic", actorId: "teacher_bootstrap", leaseMs: 1000 };
    const old = await beginAiJob({ ...common, requestKey: "old", now: start });
    const current = await beginAiJob({ ...common, requestKey: "new", now: new Date(start.getTime() + 1001) });
    if (old.kind !== "acquired" || current.kind !== "acquired") throw new Error("Expected acquired leases");
    await expect(runAiJobStep(old, "late", async () => ({ obsolete: true }))).rejects.toThrow("소유권");
    const db = await getDb();
    expect(await completeAiJob(db, old.jobId, old.leaseToken, { obsolete: true })).toBe(false);
    await failAiJob(old.jobId, old.leaseToken);
    expect(await runAiJobStep(current, "late", async () => ({ current: true }))).toEqual({ current: true });
    expect(await completeAiJob(db, current.jobId, current.leaseToken, { current: true })).toBe(true);
    expect((await db.query("SELECT job_id FROM ai_generation_job_steps WHERE job_id=$1", [old.jobId])).rows).toHaveLength(0);
  });
});
