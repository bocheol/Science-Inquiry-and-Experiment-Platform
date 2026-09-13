import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const workers = vi.hoisted(() => ({ terminate: vi.fn(), instances: [] as unknown[] }));
vi.mock("node:worker_threads", () => ({ Worker: class extends EventEmitter {
  constructor() { super(); workers.instances.push(this); }
  terminate = workers.terminate;
} }));
import { parseRoster, ROSTER_PARSE_TIMEOUT_MS, ROSTER_PARSE_ERROR } from "@/lib/roster-parser";
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); workers.instances.length = 0; });
it("terminates an unresponsive parser at its time budget", async () => {
  vi.useFakeTimers();
  const result = expect(parseRoster(new ArrayBuffer(8))).rejects.toThrow("처리 시간이 초과");
  await vi.advanceTimersByTimeAsync(ROSTER_PARSE_TIMEOUT_MS);
  await result;
  expect(workers.terminate).toHaveBeenCalledOnce();
});
it("sanitizes worker errors and terminates without exposing internal paths", async () => {
  const result = expect(parseRoster(new ArrayBuffer(8))).rejects.toThrow(ROSTER_PARSE_ERROR);
  (workers.instances[0] as EventEmitter).emit("error", new Error("synthetic-secret C:/private/path"));
  await result;
  expect(workers.terminate).toHaveBeenCalledOnce();
});
