import { test } from "node:test";
import assert from "node:assert/strict";
import { SETTINGS_SECTIONS, isSettingsSection, parseSettingsRoute, settingsHref } from "./settings-route.ts";

test("#/settings redirects to the account section", () => {
  assert.deepEqual(parseSettingsRoute(["settings"]), { kind: "redirect", to: "#/settings/account" });
});

test("every section parses to itself", () => {
  for (const section of SETTINGS_SECTIONS) {
    assert.deepEqual(parseSettingsRoute(["settings", section]), { kind: "section", section });
    assert.equal(settingsHref(section), `#/settings/${section}`);
  }
});

test("unknown sections and extra parts are not settings routes (404)", () => {
  assert.equal(parseSettingsRoute(["settings", "billing"]), null);
  assert.equal(parseSettingsRoute(["settings", "Account"]), null, "sections are lowercase");
  assert.equal(parseSettingsRoute(["settings", "account", "extra"]), null);
  assert.equal(parseSettingsRoute(["settings", ""]), null);
});

test("other routes are not the settings page", () => {
  assert.equal(parseSettingsRoute([]), null);
  assert.equal(parseSettingsRoute(["me"]), null);
  assert.equal(parseSettingsRoute(["class", "settings"]), null);
});

test("isSettingsSection only accepts the four sections", () => {
  assert.equal(isSettingsSection("privacy"), true);
  assert.equal(isSettingsSection("toString"), false);
  assert.equal(isSettingsSection(""), false);
});
