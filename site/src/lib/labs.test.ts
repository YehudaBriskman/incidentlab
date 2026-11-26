import { test } from "node:test";
import assert from "node:assert/strict";
import { labImage, labRunCommand, labTemplate } from "./labs.ts";

test("the lab image and run command follow the published naming", () => {
  assert.equal(labImage("ghost-in-the-network", 1), "ghcr.io/incidentslab/lab-ghost-in-the-network:v1");
  assert.equal(labRunCommand("who-deleted-prod", 3), "docker run -it --rm ghcr.io/incidentslab/lab-who-deleted-prod:v3");
});

test("only cases with a published template get a Codespaces link", () => {
  assert.equal(labTemplate("ghost-in-the-network"), "https://github.com/IncidentsLab/lab-ghost-in-the-network");
  assert.equal(labTemplate("3am-outage"), null);
});
