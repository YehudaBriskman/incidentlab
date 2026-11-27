import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClassMember } from "../../shared/contract.ts";
import { isClassAdmin, isOwnerLike, memberActions, type ClassCaller } from "./class-permissions.ts";

const member = (over: Partial<ClassMember>): ClassMember => ({
  accountId: "m1",
  username: "dana",
  role: "member",
  status: "active",
  isOwner: false,
  joinedAt: "2026-11-27T10:00:00.000Z",
  decidedAt: null,
  ...over,
});

const owner: ClassCaller = { accountId: "o1", membership: { role: "admin", status: "active", isOwner: true } };
const coAdmin: ClassCaller = { accountId: "c1", membership: { role: "admin", status: "active", isOwner: false } };
const plain: ClassCaller = { accountId: "p1", membership: { role: "member", status: "active", isOwner: false } };
const site: ClassCaller = { accountId: null, membership: null };

test("roles: owner and site admin are owner-like; co-admins are admins only", () => {
  assert.equal(isOwnerLike(owner), true);
  assert.equal(isOwnerLike(site), true);
  assert.equal(isOwnerLike(coAdmin), false);
  assert.equal(isClassAdmin(coAdmin), true);
  assert.equal(isClassAdmin(plain), false);
  assert.equal(isClassAdmin({ accountId: "x", membership: { role: "admin", status: "pending", isOwner: false } }), false);
});

test("pending requests: any class admin approves or declines", () => {
  for (const caller of [owner, coAdmin, site]) assert.deepEqual(memberActions(caller, member({ status: "pending" })), ["approve", "decline"]);
  assert.deepEqual(memberActions(plain, member({ status: "pending" })), []);
});

test("members: the owner promotes and removes, a co-admin only removes", () => {
  assert.deepEqual(memberActions(owner, member({})), ["promote", "remove"]);
  assert.deepEqual(memberActions(site, member({})), ["promote", "remove"]);
  assert.deepEqual(memberActions(coAdmin, member({})), ["remove"]);
});

test("co-admins: only the owner (or site admin) demotes or removes them", () => {
  const admin = member({ role: "admin" });
  assert.deepEqual(memberActions(owner, admin), ["demote", "remove"]);
  assert.deepEqual(memberActions(coAdmin, admin), []);
});

test("nobody acts on the owner or on themselves", () => {
  assert.deepEqual(memberActions(site, member({ role: "admin", isOwner: true })), []);
  assert.deepEqual(memberActions(coAdmin, member({ accountId: "c1", role: "admin" })), []);
});
