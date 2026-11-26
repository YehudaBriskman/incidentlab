// The shared zip reader (shared/zip.ts) on small archives built in the test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ZipError, crc32, openZip } from "../../shared/zip.ts";
import { writeZip } from "./zip-writer.ts";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const repeated = "a line of evidence that compresses well\n".repeat(500);

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("reads stored and deflated entries, with UTF-8 names", async () => {
  const binary = new Uint8Array(256).map((_, i) => i);
  const zip = openZip(await writeZip([
    { name: "stored.txt", data: "plain", method: 0 },
    { name: "dir/deflated.log", data: repeated, method: 8 },
    { name: "he/קובץ.txt", data: "שלום", method: 8 },
    { name: "bin/capture.pcap", data: binary, method: 8 },
  ]));
  assert.deepEqual(zip.entries.map((e) => e.name), ["stored.txt", "dir/deflated.log", "he/קובץ.txt", "bin/capture.pcap"]);
  assert.equal(zip.get("stored.txt")?.method, 0);
  const deflated = zip.get("dir/deflated.log");
  assert.ok(deflated && deflated.method === 8 && deflated.compressedSize < deflated.size);
  assert.equal(text(await zip.read("stored.txt")), "plain");
  assert.equal(text(await zip.read("dir/deflated.log")), repeated);
  assert.equal(text(await zip.read("he/קובץ.txt")), "שלום");
  assert.deepEqual(await zip.read("bin/capture.pcap"), binary);
  assert.equal(zip.get("missing"), undefined);
  await assert.rejects(zip.read("missing"), ZipError);
});

test("an empty archive has no entries", async () => {
  assert.equal(openZip(await writeZip([])).entries.length, 0);
});

test("rejects bytes that are not a zip", () => {
  assert.throws(() => openZip(new TextEncoder().encode("this is not a zip archive at all")), ZipError);
  assert.throws(() => openZip(new Uint8Array(4)), ZipError);
});

test("rejects a corrupt central directory", async () => {
  const good = await writeZip([{ name: "a.txt", data: "alpha" }, { name: "b.txt", data: "beta" }]);
  const eocd = good.length - 22;
  const cdOffset = new DataView(good.buffer).getUint32(eocd + 16, true);

  const badSignature = good.slice();
  badSignature[cdOffset] = 0; // first central header signature
  assert.throws(() => openZip(badSignature), /corrupt central directory/);

  const badCount = good.slice();
  new DataView(badCount.buffer).setUint16(eocd + 10, 3, true); // claims three entries
  new DataView(badCount.buffer).setUint16(eocd + 8, 3, true);
  assert.throws(() => openZip(badCount), /corrupt central directory/);

  const badOffset = good.slice();
  new DataView(badOffset.buffer).setUint32(eocd + 16, eocd, true); // directory "starts" at the end record
  assert.throws(() => openZip(badOffset), /corrupt central directory/);
});

test("detects corrupt entry data by CRC-32 or inflate failure", async () => {
  const stored = await writeZip([{ name: "a.txt", data: "alpha bravo", method: 0 }]);
  const flipped = stored.slice();
  const first = 30 + "a.txt".length; // first data byte
  flipped[first] = (flipped[first] ?? 0) ^ 0xff;
  await assert.rejects(openZip(flipped).read("a.txt"), /CRC-32 mismatch/);

  const deflated = await writeZip([{ name: "b.log", data: repeated, method: 8 }]);
  const broken = deflated.slice();
  for (let i = 30 + "b.log".length; i < 30 + "b.log".length + 8; i++) broken[i] = 0xff;
  await assert.rejects(openZip(broken).read("b.log"), ZipError);
});

test("rejects unsafe and duplicate entry names", async () => {
  await assert.rejects(async () => openZip(await writeZip([{ name: "../escape.txt", data: "x" }])), /unsafe entry name/);
  await assert.rejects(async () => openZip(await writeZip([{ name: "/abs.txt", data: "x" }])), /unsafe entry name/);
  await assert.rejects(
    async () => openZip(await writeZip([{ name: "same.txt", data: "1" }, { name: "same.txt", data: "2" }])),
    /duplicate entry/,
  );
});
