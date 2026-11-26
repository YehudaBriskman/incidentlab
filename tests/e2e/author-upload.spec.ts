// #66 upload page: the admin uploads a real case package from the browser, reads the draft diff, publishes it,
// deletes the case (typed confirm) and brings it back with Undo. Needs build/packages (build-all.sh makes them).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME } from "./support";

const PACKAGE = fileURLToPath(new URL("../../build/packages/the-insider-commit-v1.case.zip", import.meta.url));
const CASE_ID = "the-insider-commit";

const ui = {
  username: (p: Page) => p.getByLabel("Username", { exact: true }),
  password: (p: Page) => p.getByLabel("Password", { exact: true }),
  signInSubmit: (p: Page) => p.locator("form").getByRole("button", { name: /^sign in$/i }),
  file: (p: Page) => p.getByLabel("Case package (.case.zip)"),
  upload: (p: Page) => p.getByRole("button", { name: "Upload", exact: true }),
  diff: (p: Page) => p.locator(".author-diff"),
  row: (p: Page) => p.locator("tr", { hasText: CASE_ID }),
  actions: (p: Page) => p.getByRole("button", { name: `Actions for ${CASE_ID}` }),
  dialog: (p: Page) => p.getByRole("alertdialog"),
};

test("author page: upload a package, publish the draft, delete and undo", async ({ page }) => {
  test.skip(!existsSync(PACKAGE), "no case packages (run scripts/build-all.sh)");
  test.setTimeout(120_000);

  await page.goto("/#/login");
  await ui.username(page).fill(ADMIN_USERNAME);
  await ui.password(page).fill(ADMIN_KEY);
  await ui.signInSubmit(page).click();
  await page.waitForURL((url) => !url.hash.startsWith("#/login"));
  await page.getByRole("link", { name: "Authoring" }).first().click();
  await expect(page.getByRole("heading", { name: "Case authoring" })).toBeVisible();

  await test.step("upload saves a draft and shows what changed", async () => {
    await ui.upload(page).click();
    await expect(page.getByText("Choose a .case.zip file first.")).toBeVisible(); // error tied to the field
    await ui.file(page).setInputFiles(PACKAGE);
    await ui.upload(page).click();
    await expect(ui.diff(page)).toBeVisible({ timeout: 90_000 });
    await expect(ui.diff(page)).toContainText(/Draft v\d+/);
    await expect(ui.row(page)).toBeVisible();
  });

  await test.step("publish from the diff, with a confirm", async () => {
    await ui.diff(page).getByRole("button", { name: /^Publish v\d+$/ }).click();
    await ui.dialog(page).getByRole("button", { name: /^Publish v\d+$/ }).click();
    await expect(page.locator(".toast", { hasText: "is live" })).toBeVisible();
    await expect(ui.row(page)).toContainText("Published");
    const listed = await page.request.get("/api/cases");
    expect(JSON.stringify(await listed.json())).toContain(CASE_ID);
  });

  await test.step("delete needs the case id typed; Undo restores it", async () => {
    await ui.actions(page).click();
    await page.getByRole("menuitem", { name: "Delete case…" }).click();
    const confirmBtn = ui.dialog(page).getByRole("button", { name: "Delete case" });
    await expect(confirmBtn).toBeDisabled();
    await ui.dialog(page).getByRole("textbox").fill(CASE_ID);
    await confirmBtn.click();
    const toast = page.locator(".toast", { hasText: "was deleted" });
    await expect(toast).toBeVisible();
    await expect(ui.row(page)).toContainText("Deleted");
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(ui.row(page)).toContainText("Published");
  });
});
