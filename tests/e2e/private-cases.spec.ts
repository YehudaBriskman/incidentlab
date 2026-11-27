// Private cases and owner review (#184): an author uploads a case from the browser and it stays private, a
// stranger can't find or open it, the author assigns it to a class they admin, a member plays it (deep link
// included), the author submits it, and the owner approves it from the review queue, after which it is public.
// The package is the server tests' made-up fixture (site/server/test/package-fixture.ts), under a fresh id.
import { writeFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ANSWERS, build, fixture } from "../../site/server/test/package-fixture.ts";
import { ADMIN_KEY, ADMIN_USERNAME, adminHeaders, randomUsername } from "./support";

const PASSWORD = "e2e-password-123";

const ui = {
  file: (p: Page) => p.getByLabel("Case package (.case.zip)"),
  publishAfter: (p: Page) => p.getByLabel("Publish right after the upload"),
  upload: (p: Page) => p.getByRole("button", { name: "Upload", exact: true }),
  row: (p: Page, id: string) => p.locator("tr", { hasText: id }),
  actions: (p: Page, id: string) => p.getByRole("button", { name: `Actions for ${id}` }),
  toast: (p: Page, text: string | RegExp) => p.locator(".toast", { hasText: text }),
};

/** Signs up in this request context (its cookie jar is the page's when it is `page.request`). */
async function signUp(request: APIRequestContext, prefix: string): Promise<{ id: string; username: string }> {
  const username = randomUsername(prefix);
  const res = await request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  const { account } = (await res.json()) as { account: { id: string } };
  return { id: account.id, username };
}

test("private case: hidden until the owner approves it, playable by an assigned class", async ({ page, browser, playwright, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const caseId = `e2e-private-${Math.random().toString(36).slice(2, 8)}`;
  const pkg = testInfo.outputPath(`${caseId}.case.zip`);
  writeFileSync(pkg, await build(fixture(caseId)));

  const stranger = await playwright.request.newContext({ baseURL });
  const anonymous = await playwright.request.newContext({ baseURL });
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();

  const author = await signUp(page.request, "e2epriv");
  const granted = await page.request.put(`/api/admin/accounts/${author.id}/role`, { headers: adminHeaders, data: { role: "author" } });
  expect(granted.status(), await granted.text()).toBe(200);
  await signUp(stranger, "e2estranger");
  await signUp(memberContext.request, "e2emember");

  await test.step("the author uploads and publishes: the case is private", async () => {
    await page.goto("/#/author");
    await expect(page.getByRole("heading", { name: "Case authoring" })).toBeVisible();
    await ui.file(page).setInputFiles(pkg);
    await ui.publishAfter(page).check();
    await ui.upload(page).click();
    await expect(ui.toast(page, "is live for you and your assigned classes")).toBeVisible({ timeout: 90_000 });
    await expect(ui.row(page, caseId).getByText("Private", { exact: true })).toBeVisible();
  });

  await test.step("a stranger can't find or open it", async () => {
    for (const ctx of [anonymous, stranger]) {
      const catalog = await ctx.get("/api/cases");
      expect(catalog.status()).toBe(200);
      expect(await catalog.text()).not.toContain(caseId);
      expect((await ctx.get(`/api/cases/${caseId}/content`)).status()).toBe(404);
    }
    expect((await stranger.get(`/api/cases/${caseId}/progress`)).status()).toBe(404);
    expect(await (await anonymous.get("/api/today")).text()).not.toContain(caseId);
  });

  await test.step("the author assigns it to a class they admin; a member plays it", async () => {
    const created = await page.request.post("/api/classes", { data: { name: "Private case class" } });
    expect(created.status(), await created.text()).toBe(201);
    const { class: cls } = (await created.json()) as { class: { id: string; admin: { joinCode: string } } };
    const joined = await memberContext.request.post("/api/classes/join", { data: { code: cls.admin.joinCode } });
    expect(joined.status(), await joined.text()).toBe(200);
    expect((await memberContext.request.get(`/api/cases/${caseId}/content`)).status()).toBe(404);

    await ui.actions(page, caseId).click();
    await page.getByRole("menuitem", { name: "Classes…" }).click();
    const dialog = page.getByRole("dialog", { name: `Classes that may play ${caseId}` });
    await dialog.getByLabel("Private case class").check();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(ui.toast(page, "1 class assigned")).toBeVisible();
    await expect(ui.row(page, caseId)).toContainText("1 class");
    // The class admin puts it on the class (its board counts it).
    const put = await page.request.patch(`/api/classes/${cls.id}`, { data: { caseIds: [caseId] } });
    expect(put.status(), await put.text()).toBe(200);

    // The member's catalog has it: a deep link opens the case.
    await memberPage.goto(`/#/case/${caseId}`);
    await expect(memberPage.getByRole("heading", { name: "Fixture case" }).first()).toBeVisible();
    const req = memberContext.request;
    expect((await req.get(`/api/cases/${caseId}/progress`)).status()).toBe(200);
    expect((await req.post(`/api/cases/${caseId}/setup-done`, { data: {} })).status()).toBe(200);
    const answer = await req.post(`/api/cases/${caseId}/answer`, { data: { questionId: "q1", answer: ANSWERS["q1"] } });
    expect(answer.status(), await answer.text()).toBe(200);
    expect(((await answer.json()) as { correct: boolean }).correct).toBe(true);
    // Still private to everyone else.
    expect((await stranger.get(`/api/cases/${caseId}/content`)).status()).toBe(404);
  });

  await test.step("the author submits it for review", async () => {
    await ui.actions(page, caseId).click();
    await page.getByRole("menuitem", { name: "Submit for review" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Submit for review" }).click();
    await expect(ui.toast(page, "is waiting for review")).toBeVisible();
    await expect(ui.row(page, caseId)).toContainText("Waiting for review");
  });

  await test.step("the owner approves it from the queue: it is public", async () => {
    const login = await ownerPage.request.post("/api/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_KEY } });
    expect(login.ok()).toBe(true);
    await ownerPage.goto("/#/author");
    await ownerPage.getByRole("link", { name: "Review queue" }).click();
    await expect(ownerPage.getByRole("heading", { name: "Review queue" })).toBeVisible();
    await expect(ui.row(ownerPage, caseId)).toContainText(author.username);
    await ownerPage.getByRole("button", { name: `Review actions for ${caseId}` }).click();
    await ownerPage.getByRole("menuitem", { name: "Approve…" }).click();
    const dialog = ownerPage.getByRole("alertdialog");
    await dialog.getByLabel("Note to the author").fill("Nice work.");
    await dialog.getByRole("button", { name: "Approve and publish" }).click();
    await expect(ui.toast(ownerPage, "is public now")).toBeVisible();
    await expect(ui.row(ownerPage, caseId)).toHaveCount(0);

    const catalog = await anonymous.get("/api/cases");
    expect(await catalog.text()).toContain(caseId);
    expect((await stranger.get(`/api/cases/${caseId}/content`)).status()).toBe(200);
    await page.reload();
    await expect(ui.row(page, caseId).getByText("Public", { exact: true })).toBeVisible();
    await expect(ui.row(page, caseId)).toContainText("Nice work.");
  });

  await Promise.all([stranger.dispose(), anonymous.dispose(), memberContext.close(), ownerContext.close()]);
});
