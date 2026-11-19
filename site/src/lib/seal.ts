import type { SealedDebrief } from "../content/sealed";

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.trim());
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * key = SHA-256(order.map(id => normalizedAnswer[id]).join("|")), AES-256-GCM.
 * `answers` must already be normalized (they are stored that way on solve).
 */
export async function unsealDebrief(sealed: SealedDebrief, answers: Readonly<Record<string, string>>): Promise<string> {
  const parts = sealed.order.map((id) => {
    const a = answers[id];
    if (a === undefined) throw new Error(`missing answer for ${id}`);
    return a;
  });
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("|")));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(sealed.iv), tagLength: 128 },
    key,
    base64ToBytes(sealed.ct),
  );
  return new TextDecoder().decode(plain);
}
