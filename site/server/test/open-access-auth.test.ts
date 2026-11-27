// Open sign-up (#173).
import { test } from "node:test";
import { createHarness, expectStatus } from "./helpers.ts";

const PASSWORD = "hunter2hunter2";

test("bot checks: a filled honeypot or a too-fast form gets a generic 400; real and older clients pass", async () => {
  const { client } = createHarness();
  const base = { password: PASSWORD };
  await expectStatus(client().call("/auth/register", { body: { ...base, username: "botone", website: "http://spam.example" } }), 400, "signup-refused");
  await expectStatus(client().call("/auth/register", { body: { ...base, username: "bottwo", elapsedMs: 300 } }), 400, "signup-refused");
  // refused sign-ups create nothing: both names are still free
  await expectStatus(client().call("/auth/login", { body: { username: "botone", password: PASSWORD } }), 401, "bad-credentials");
  await expectStatus(client().call("/auth/register", { body: { ...base, username: "botone", website: "", elapsedMs: 4_000 } }), 201);
  // an older client sends neither field
  await expectStatus(client().call("/auth/register", { body: { ...base, username: "oldclient" } }), 201);
});

test("sign-ups are limited to 20 an hour per address; reserved names stay reserved", async () => {
  const { client } = createHarness();
  for (let i = 0; i < 20; i++) await expectStatus(client("10.5.5.5").call("/auth/register", { body: { username: `crowd${i}`, password: PASSWORD } }), 201);
  await expectStatus(client("10.5.5.5").call("/auth/register", { body: { username: "crowd20", password: PASSWORD } }), 429, "rate-limited");
  await expectStatus(client("10.6.6.6").call("/auth/register", { body: { username: "Instructor", password: PASSWORD } }), 409, "reserved");
});
