// Local stand-in for Netlify: serves site/dist plus the real /api handler on the in-memory store.
// Usage: node --experimental-strip-types tests/local-server.ts [port=8888] [--seed-db-case] [--no-cases]
//   ADMIN_KEY defaults to "local-admin-key-0123456789" (16+ chars required).
//   /evidence/db/* goes through the same EvidenceService as the Edge Function, on the same memory store.
//   Every case package in build/packages/ (scripts/build-all.sh writes them) is uploaded and published at
//   startup, through the same upload API as `scripts/data.ts upload --publish`: since #68 the site has no
//   bundled cases, so this is how the local store gets them. --no-cases starts with an empty store.
//   --seed-db-case (dev only) also stores a published DB case `db-demo` v1 with a 9 MiB file, for Range checks.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

process.env.INCIDENTLAB_STORE = "memory";
process.env.ADMIN_KEY ??= "local-admin-key-0123456789";
const { default: handler, appStores } = await import("../site/netlify/functions/api.mts");
const { CaseRepository, EvidenceChunkRepository } = await import("../site/server/repositories/case-repository.ts");
const { EvidenceService, EVIDENCE_DB_PREFIX } = await import("../site/server/services/evidenceStream.ts");

const DIST = new URL("../site/dist/", import.meta.url).pathname;
const args = process.argv.slice(2);
const PORT = Number(args.find((a) => /^\d+$/.test(a)) ?? 8888);
const caseRepo = new CaseRepository(appStores().kv);
const chunkRepo = new EvidenceChunkRepository(appStores().bytes);
const evidence = new EvidenceService({ cases: caseRepo, chunks: chunkRepo });

if (args.includes("--seed-db-case")) {
  const { seedCase, patternBytes } = await import("../site/server/test/case-fixtures.ts");
  await seedCase({ cases: caseRepo, chunks: chunkRepo }, {
    id: "db-demo",
    langs: ["en", "he"],
    files: [{ path: "logs/big.log", bytes: patternBytes(9 * 1024 * 1024 + 123) }, { path: "logs/app.log", bytes: new TextEncoder().encode("hello\n") }],
    zip: patternBytes(1000, 7),
  });
  console.log("seeded DB case db-demo v1: /evidence/db/db-demo/v1/files/logs/big.log (9 MiB + 123 B)");
}
if (!args.includes("--no-cases")) {
  const { uploadCommand } = await import("../scripts/upload-case.ts");
  const packagesDir = new URL("../build/packages/", import.meta.url).pathname;
  const packages = (await readdir(packagesDir).catch(() => [] as string[])).filter((f) => f.endsWith(".case.zip"));
  // Oldest version first, so the highest version of each case ends up published.
  const version = (f: string): number => Number(/-v(\d+)\.case\.zip$/.exec(f)?.[1] ?? 0);
  packages.sort((a, b) => version(a) - version(b) || a.localeCompare(b));
  if (packages.length === 0) console.warn(`[local] no case packages in ${packagesDir}: the site will list no cases (run scripts/build-all.sh)`);
  const inProcess = (input: string, init: RequestInit): Promise<Response> => handler(new Request(input, init), { ip: "127.0.0.1" });
  for (const file of packages) {
    await uploadCommand({
      file: join(packagesDir, file), url: `http://localhost:${PORT}`, publish: true, acceptAnswerChanges: false,
      adminKey: process.env.ADMIN_KEY ?? "", fetch: inProcess, log: () => undefined,
    });
    console.log(`[local] published ${file}`);
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".json": "application/json", ".zip": "application/zip", ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
};

const readBody = async (req: import("node:http").IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    // Every local client is 127.0.0.1, so the per-IP limits (20 sign-ups an hour since #173) would trip over the
    // e2e suite's own sign-ups. Loopback clients are keyed per connection instead; the limits themselves are
    // covered by the server tests.
    const remote = req.socket.remoteAddress ?? "127.0.0.1";
    const ip = /^(127\.|::1$|::ffff:127\.)/.test(remote) ? `${remote}:${req.socket.remotePort ?? 0}` : remote;
    const response = await handler(new Request(url, { method: req.method, headers, body }), { ip });
    const outHeaders: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => (outHeaders[key] = value));
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) outHeaders["set-cookie"] = cookies;
    res.writeHead(response.status, outHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  if (url.pathname.startsWith(EVIDENCE_DB_PREFIX)) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const response = await evidence.respond(new Request(url, { method: req.method, headers }));
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => (outHeaders[key] = value));
    res.writeHead(response.status, outHeaders);
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
    return;
  }
  const safe = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, safe);
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(DIST, "index.html"); // SPA fallback
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-security-policy": "connect-src 'self'" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => console.log(`IncidentLab local: http://localhost:${PORT}  (admin key: ${process.env.ADMIN_KEY})`));
