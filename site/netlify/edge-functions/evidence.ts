// Netlify Edge Function (Deno) for DB-stored evidence, declared in netlify.toml on /evidence/db/*:
//   /evidence/db/<id>/v<n>/files/<path>   one evidence file
//   /evidence/db/<id>/v<n>.zip            the prebuilt evidence zip
// Why an Edge Function and not the /api Function: evidence files go up to 40 MB, past the Function's
// ~6 MB buffered / ~20 MB streamed response limits. Here the chunks stream straight from Blobs, which is
// I/O, not CPU, so it fits the edge CPU budget. The URL carries the version, so responses are immutable.
//
// All logic is in server/services/evidenceStream.ts (web APIs only), shared with the node tests and
// tests/local-server.ts. Since #68 this is the only evidence the site serves (no static /evidence/ files).
import { BlobsByteStore } from "../../server/repositories/ByteStore.ts";
import { CaseRepository, EvidenceChunkRepository } from "../../server/repositories/case-repository.ts";
import { BlobsKvStore } from "../../server/repositories/KvStore.ts";
import { EvidenceService } from "../../server/services/evidenceStream.ts";

export default async (req: Request): Promise<Response> => {
  // Built per request: the Blobs client reads its per-request token from the environment. Eventual
  // consistency is enough because published versions are immutable (a new version is a new URL).
  const service = new EvidenceService({
    cases: new CaseRepository(new BlobsKvStore({ consistency: "eventual" })),
    chunks: new EvidenceChunkRepository(new BlobsByteStore({ consistency: "eventual" })),
  });
  try {
    return await service.respond(req);
  } catch (error) {
    console.error("[incidentlab-evidence] failed", error);
    return new Response("internal error", { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
};
