export type FormDataBodyResult =
  | { kind: "ok"; data: FormData }
  | { kind: "too-large" | "invalid" };

// Bound multipart bytes before the platform parser buffers file contents.
export async function readFormDataBody(request: Request, maxBytes: number): Promise<FormDataBodyResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      await request.body?.cancel().catch(() => undefined);
      return { kind: size > maxBytes ? "too-large" : "invalid" };
    }
  }
  const reader = request.body?.getReader();
  if (!reader) return { kind: "invalid" };
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too-large" };
      }
      chunks.push(part.value);
    }
    const data = await new Response(Buffer.concat(chunks), { headers: request.headers }).formData();
    return { kind: "ok", data };
  } catch {
    return { kind: "invalid" };
  } finally {
    reader.releaseLock();
  }
}
