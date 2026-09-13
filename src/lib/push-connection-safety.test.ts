import { expect, it, vi } from "vitest";
import { createServer, type LookupFunction } from "node:net";
import { get } from "node:https";
import { assertSafePushDestination, createSafePushAgent, UnsafePushDestinationError } from "@/lib/push-notifications";

const host = "push-provider.example.com", endpoint = `https://${host}/synthetic`;
function resolved(agent: ReturnType<typeof createSafePushAgent>, hostname = host, all = false, family = 0) {
  return new Promise<unknown>((resolve, reject) => (agent.options.lookup as LookupFunction)(hostname, { all, family }, (error, address, returnedFamily) => error ? reject(error) : resolve({ address, family: returnedFamily })));
}
it.each(["10.0.0.1", "127.0.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"])("rejects a DNS change to %s at connection time", async address => {
  const resolver = vi.fn().mockResolvedValueOnce(["8.8.8.8"]).mockResolvedValueOnce([address]);
  await assertSafePushDestination(endpoint, resolver);
  const agent = createSafePushAgent(endpoint, resolver);
  try { await expect(resolved(agent)).rejects.toBeInstanceOf(UnsafePushDestinationError); expect(resolver).toHaveBeenCalledTimes(2); }
  finally { agent.destroy(); }
});
it("passes the exact validated public addresses to the socket without a second lookup", async () => {
  const resolver = vi.fn(async () => ["8.8.8.8", "2001:4860:4860::8888"]);
  const agent = createSafePushAgent(endpoint, resolver);
  try {
    expect(await resolved(agent, host, true)).toEqual({ address: [{ address: "8.8.8.8", family: 4 }, { address: "2001:4860:4860::8888", family: 6 }], family: undefined });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(await resolved(agent, host, false, 6)).toEqual({ address: "2001:4860:4860::8888", family: 6 });
    expect(resolver).toHaveBeenCalledTimes(2);
    await expect(resolved(agent, "different.example.com")).rejects.toBeInstanceOf(UnsafePushDestinationError);
    expect(resolver).toHaveBeenCalledTimes(2);
  } finally { agent.destroy(); }
});
it("keeps temporary connection DNS failure distinct from unsafe addresses", async () => {
  const failure = Object.assign(new Error("Synthetic temporary DNS failure"), { code: "EAI_AGAIN" });
  const agent = createSafePushAgent(endpoint, async () => { throw failure; });
  try { await expect(resolved(agent)).rejects.toBe(failure); expect(failure).not.toBeInstanceOf(UnsafePushDestinationError); }
  finally { agent.destroy(); }
});
it("rejects a mixed public/private answer and a literal private endpoint", async () => {
  const agent = createSafePushAgent(endpoint, async () => ["8.8.8.8", "10.0.0.1"]);
  try { await expect(resolved(agent, host, true)).rejects.toBeInstanceOf(UnsafePushDestinationError); }
  finally { agent.destroy(); }
  expect(() => createSafePushAgent("https://127.0.0.1/push")).toThrow(UnsafePushDestinationError);
});
it("uses the guard in a real HTTPS request without connecting to a local listener", async () => {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local test port");
  const url = `https://${host}:${address.port}/synthetic`;
  const agent = createSafePushAgent(url, async () => ["127.0.0.1"]);
  try {
    const request = new Promise((resolve, reject) => {
      const req = get(url, { agent, timeout: 2000 }, resolve);
      req.on("error", reject); req.on("timeout", () => req.destroy(new Error("Synthetic request timeout")));
    });
    await expect(request).rejects.toBeInstanceOf(UnsafePushDestinationError);
    expect(connections).toBe(0);
  } finally { agent.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
