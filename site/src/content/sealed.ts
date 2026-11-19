import { z } from "zod";

/** Encrypted debrief produced by scripts/seal_debrief.mjs. */
export const SealedDebriefSchema = z.object({
  caseId: z.string(),
  order: z.array(z.string()).min(1),        // question ids whose answers form the key
  iv: z.string().min(1),                    // base64, 12 bytes
  ct: z.string().min(1),                    // base64, ciphertext || 16-byte GCM tag
});
export type SealedDebrief = z.infer<typeof SealedDebriefSchema>;
