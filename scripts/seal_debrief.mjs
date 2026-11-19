#!/usr/bin/env node
// Encrypts the case debrief so it can ship in the client bundle without leaking answers.
// key = SHA-256( normalized q1 + "|" + q2 + ... + "|" + q6 ), cipher = AES-256-GCM.
// The site re-derives the same key from the player's correct answers once all are solved.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const answers = JSON.parse(readFileSync(`${root}build/truth/answers.json`, "utf8"));
const normalized = answers.normalized;
const ids = Object.keys(normalized).sort();
const key = createHash("sha256").update(ids.map((id) => normalized[id]).join("|")).digest();
const plain = readFileSync(`${root}content-sealed/3am-outage.debrief.md`, "utf8");
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, iv);
const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
const out = { caseId: answers.caseId, order: ids, iv: iv.toString("base64"), ct: ct.toString("base64") };
writeFileSync(`${root}site/src/generated/debrief.sealed.json`, JSON.stringify(out, null, 2) + "\n");
console.log(`[seal_debrief] sealed ${plain.length} chars -> site/src/generated/debrief.sealed.json`);
