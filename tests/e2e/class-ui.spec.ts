// The class UI (#182) end to end in the browser: create a class, copy its join link, join through #/join/<code>,
// assigned cases and an event window from Manage, a solve on the embedded class board and on the projector,
// approval mode (a request, then approve) and the class limit on the 4th class.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { answerFor, randomUsername } from "./support";

const PASSWORD = "e2e-password-123";
const CASE_ID = "3am-outage";

/** A signed-in player in a fresh browser context (cookie set through the API, then the page uses it). */
async function signedIn(browser: Browser, prefix: string): Promise<{ context: BrowserContext; page: Page; username: string }> {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  const username = randomUsername(prefix);
  const res = await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  return { context, page, username };
}

test("classes: create, share the link, join, assign cases and an event, solve, board, projector, approval, limit", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await signedIn(browser, "e2euio");
  const member = await signedIn(browser, "e2euim");
  const asker = await signedIn(browser, "e2euia");

  // The owner creates a class from #/classes: the dialog lands on its management page.
  await owner.page.goto("/#/classes");
  await expect(owner.page.getByRole("heading", { level: 1, name: "Classes" })).toBeVisible();
  await owner.page.getByRole("button", { name: "Create class" }).click();
  const dialog = owner.page.getByRole("dialog", { name: "Create a class" });
  await dialog.getByLabel("Class name").fill("E2E UI class");
  await dialog.getByRole("button", { name: "Create class" }).click();
  await expect(owner.page).toHaveURL(/#\/class\/[0-9A-Za-z]{12}\/manage/);
  await expect(owner.page.locator(".admin-title")).toHaveText("E2E UI class");
  const classId = /#\/class\/([0-9A-Za-z]{12})\//.exec(owner.page.url())?.[1] ?? "";

  // Settings: copy the join link.
  await owner.page.locator(".nav-sub").getByRole("link", { name: "Settings" }).click();
  await owner.page.getByRole("button", { name: "Copy link" }).click();
  const link = await owner.page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/#\/join\/[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  const code = link.split("/join/")[1] ?? "";

  // A second player opens the link and joins at once (the class takes anyone with the code).
  await member.page.goto(`/#/join/${code}`);
  await expect(member.page.getByRole("heading", { name: "You joined E2E UI class" })).toBeVisible();
  await member.page.getByRole("link", { name: "Open the class" }).click();
  await expect(member.page.getByRole("heading", { level: 1, name: "E2E UI class" })).toBeVisible();
  await expect(member.page.getByRole("heading", { name: "Class board" })).toBeVisible();

  // The owner assigns a case and opens an event window from Manage.
  await owner.page.locator(".nav-sub").getByRole("link", { name: "Cases" }).click();
  await owner.page.locator(`#class-case-${CASE_ID}`).check();
  await owner.page.getByRole("button", { name: "Save" }).click();
  await expect(owner.page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await owner.page.locator(".nav-sub").getByRole("link", { name: "Event" }).click();
  await owner.page.getByRole("button", { name: "Start now (60 min)" }).click();
  await expect(owner.page.locator("#admin-panel-event, #class-panel-event").getByText(/Live/).first()).toBeVisible();
  await expect.poll(async () => {
    const res = await owner.page.request.get(`/api/classes/${classId}`);
    const body = (await res.json()) as { class: { caseIds?: string[]; event?: { startsAt: string | null; endsAt: string | null } } };
    return [body.class.caseIds, body.class.event?.startsAt !== null, body.class.event?.endsAt !== null];
  }).toEqual([[CASE_ID], true, true]);

  // The member solves a stage; the class page lists the case and the board shows them.
  expect((await member.page.request.post(`/api/cases/${CASE_ID}/setup-done`, { data: {} })).status()).toBe(200);
  const solved = await member.page.request.post(`/api/cases/${CASE_ID}/answer`, { data: { questionId: "q1", answer: answerFor(CASE_ID, "q1") } });
  expect(((await solved.json()) as { correct: boolean }).correct).toBe(true);
  await member.page.reload();
  await expect(member.page.getByRole("heading", { name: "Assigned cases" })).toBeVisible();
  await expect(member.page.locator(".class-case-list")).toContainText("The 3 AM Outage");
  const boardRow = member.page.locator(".class-board .lb-table tbody tr").filter({ hasText: member.username });
  await expect(boardRow).toBeVisible({ timeout: 20_000 });

  // The projector: the board URL in big-screen mode, without any session.
  const projectorHref = await member.page.getByRole("link", { name: "Projector", exact: true }).getAttribute("href");
  expect(projectorHref).toMatch(/^#\/classboard\/.+\?projector=1$/);
  const room = await browser.newContext();
  const screen = await room.newPage();
  await screen.goto(`/${projectorHref ?? ""}`);
  await expect(screen.locator(".lb-page.is-projector")).toBeVisible();
  await expect(screen.getByRole("heading", { level: 1, name: "E2E UI class" })).toBeVisible();
  await expect(screen.locator(".lb-table")).toContainText(member.username);
  await room.close();

  // Approval mode: a request waits until the owner approves it.
  await owner.page.locator(".nav-sub").getByRole("link", { name: "Settings" }).click();
  await owner.page.getByLabel("A class admin approves each request").check();
  await expect(owner.page.getByText("Join mode saved.")).toBeVisible();
  await asker.page.goto(`/#/join/${code}`);
  await expect(asker.page.getByRole("heading", { name: "Request sent to E2E UI class" })).toBeVisible();
  await owner.page.locator(".nav-sub").getByRole("link", { name: "Members" }).click();
  const request = owner.page.locator(".class-request").filter({ hasText: asker.username });
  await expect(request).toBeVisible();
  await request.getByRole("button", { name: "Approve" }).click();
  await expect(request).toHaveCount(0);
  await expect(owner.page.locator(".class-members-table, .acct-cards").getByText(asker.username)).toBeVisible();
  await asker.page.goto(`/#/class/${classId}`);
  await expect(asker.page.getByRole("heading", { name: "Class board" })).toBeVisible();

  // The class limit: two more classes, then the 4th says how many one may own.
  for (const name of ["E2E second", "E2E third"]) expect((await owner.page.request.post("/api/classes", { data: { name } })).status()).toBe(201);
  await owner.page.goto("/#/classes");
  await expect(owner.page.locator(".classes-table")).toContainText("E2E third");
  await owner.page.getByRole("button", { name: "Create class" }).click();
  const again = owner.page.getByRole("dialog", { name: "Create a class" });
  await again.getByLabel("Class name").fill("E2E fourth");
  await again.getByRole("button", { name: "Create class" }).click();
  await expect(again.getByText("You already own 3 active classes")).toBeVisible();

  for (const p of [owner, member, asker]) await p.context.close();
});

test("classes: guests see the upgrade note and visitors the sign-in links", async ({ browser }) => {
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  await page.goto("/#/classes");
  await expect(page.getByRole("heading", { name: "Sign in to see your classes" })).toBeVisible();
  await expect(page.locator(".class-note").getByRole("link", { name: "Sign in" })).toBeVisible();
  expect((await page.request.post("/api/guest", { data: {} })).status()).toBe(201);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Create an account to join classes" })).toBeVisible();
  await page.locator(".class-note").getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("dialog", { name: "Create your account" })).toBeVisible();
  await visitor.close();
});
