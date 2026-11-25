// Local stand-in for Netlify: serves site/dist plus the real /api handler on the in-memory store.
// Usage: node --experimental-strip-types tests/local-server.ts [port=8888]
//   ADMIN_KEY defaults to "local-admin-key-0123456789" (16+ chars required).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

process.env.INCIDENTLAB_STORE = "memory";
process.env.ADMIN_KEY ??= "local-admin-key-0123456789";
const { default: handler } = await import("../site/netlify/functions/api.mts");

const DIST = new URL("../site/dist/", import.meta.url).pathname;
const PORT = Number(process.argv[2] ?? 8888);
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
    const response = await handler(new Request(url, { method: req.method, headers, body }), { ip: req.socket.remoteAddress ?? "127.0.0.1" });
    const outHeaders: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => (outHeaders[key] = value));
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) outHeaders["set-cookie"] = cookies;
    res.writeHead(response.status, outHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
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
