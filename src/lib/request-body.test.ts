import { expect, it } from "vitest";
import { JSON_BODY_MAX_BYTES, readJsonBody } from "@/lib/request-body";

it("reads a valid Unicode JSON body within the shared limit", async () => {
  await expect(readJsonBody(new Request("http://localhost/api", { method: "POST", body: JSON.stringify({ text: "한글 입력" }) }))).resolves.toEqual({ text: "한글 입력" });
});

it("rejects malformed JSON and invalid UTF-8 safely", async () => {
  await expect(readJsonBody(new Request("http://localhost/api", { method: "POST", body: "{" }))).resolves.toBeNull();
  await expect(readJsonBody(new Request("http://localhost/api", { method: "POST", body: new Uint8Array([0xff]) }))).resolves.toBeNull();
});

it("rejects an oversized declared length without pulling the stream", async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({ pull(controller) { pulls += 1; controller.enqueue(new Uint8Array([123, 125])); }, cancel() { cancelled = true; } });
  const request = new Request("http://localhost/api", { method: "POST", headers: { "content-length": String(JSON_BODY_MAX_BYTES + 1) }, body, duplex: "half" } as RequestInit & { duplex: "half" });
  await Promise.resolve();
  const before = pulls;
  await expect(readJsonBody(request)).resolves.toBeNull();
  expect(pulls).toBe(before);
  expect(cancelled).toBe(true);
});

it("cancels a chunked stream as soon as its actual bytes exceed the limit", async () => {
  let cancelled = false, sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { if (!sent) { sent = true; controller.enqueue(new Uint8Array(JSON_BODY_MAX_BYTES + 1)); } },
    cancel() { cancelled = true; },
  });
  const request = new Request("http://localhost/api", { method: "POST", body, duplex: "half" } as RequestInit & { duplex: "half" });
  await expect(readJsonBody(request)).resolves.toBeNull();
  expect(cancelled).toBe(true);
});
