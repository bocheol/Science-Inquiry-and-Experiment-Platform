const encoder = new TextEncoder();
export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function fromBase64(value: string) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
export async function importRecoveryKey(encoded: string) {
  return crypto.subtle.importKey("raw", fromBase64(encoded), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptRecovery(key: CryptoKey, bytes: Uint8Array, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, key, new Uint8Array(bytes));
  return new Blob([iv, encrypted]);
}
export async function decryptRecovery(key: CryptoKey, box: Blob, context: string) {
  const bytes = new Uint8Array(await box.arrayBuffer());
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(context) }, key, bytes.slice(12)));
}
export async function sealLegacyKey(publicKey: string, ownerId: string, encodedKey: string) {
  const pem = publicKey.replace(/-----[^-]+-----|\s/g, "");
  const rsa = await crypto.subtle.importKey("spki", fromBase64(pem), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  return toBase64(new Uint8Array(await crypto.subtle.encrypt("RSA-OAEP", rsa, encoder.encode(JSON.stringify({ ownerId, key: encodedKey })))));
}
