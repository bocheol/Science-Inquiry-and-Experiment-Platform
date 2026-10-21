import { expect, it } from "vitest";
import { decryptRecovery, encryptRecovery, importRecoveryKey, toBase64 } from "@/lib/journal-crypto";

it("authenticates ciphertext and its owner/scope/revision without persisting an extractable key", async () => {
  const key = await importRecoveryKey(toBase64(crypto.getRandomValues(new Uint8Array(32))));
  const raw = new TextEncoder().encode("합성 학생의 비공개 초안");
  const box = await encryptRecovery(key, raw, "owner:scope:1");
  expect(new TextDecoder().decode(await box.arrayBuffer())).not.toContain("비공개");
  expect(await decryptRecovery(key, box, "owner:scope:1")).toEqual(raw);
  await expect(decryptRecovery(key, box, "other:scope:1")).rejects.toThrow();
  await expect(decryptRecovery(key, box, "owner:scope:2")).rejects.toThrow();
  await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  const bytes = new Uint8Array(await box.arrayBuffer()); bytes[bytes.length - 1] ^= 1;
  await expect(decryptRecovery(key, new Blob([bytes]), "owner:scope:1")).rejects.toThrow();
});
