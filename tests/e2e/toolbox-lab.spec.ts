// Toolbox lab variant (#149), compact command rows (#214) and load-error Retry (#138): one page-wide shell switch
// (no per-row tabs) offers Lab only when the case has a lab variant, a row without the chosen variant says it
// shows Bash, arrow keys move across the switch, the paid lab command is absent until the single reveal (which
// leaves the row open with Copy focused), "This stage" and `/` narrow the list, and a failed progress load
// offers Retry.
import { expect, test, type Page } from "@playwright/test";
import { approveAccount, randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";
// Paid: the runnable lab command of tcpdump-read. It must never be on the page before the reveal.
const PAID_LAB = "tcpdump -nn -tttt -v -r pcap/app-03_large-request.pcap | head -n 20";

const row = (p: Page, toolId: string) => p.locator(`.tool-list [data-tool="${toolId}"]`);
const shell = (p: Page, name: string) => p.getByRole("radio", { name, exact: true });

test("Lab only where a lab variant exists; paid lab command only after the reveal", async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  const username = randomUsername("lab");

  await test.step("approved player who finished setup", async () => {
    await scheduleToday(request, CASE_ID);
    const reg = await request.post("/api/auth/register", { data: { username, password: PASSWORD } });
    expect(reg.status()).toBe(201);
    await approveAccount(request, username);
    expect((await page.request.post("/api/auth/login", { data: { username, password: PASSWORD } })).status()).toBe(200);
    expect((await page.request.get(`/api/cases/${CASE_ID}/progress`)).status()).toBe(200);
    expect((await page.request.post(`/api/cases/${CASE_ID}/setup-done`, { data: {} })).status()).toBe(200);
  });

  await test.step("one page-wide switch, no per-row tabs; rows are one-line disclosures", async () => {
    await page.goto(`/#/case/${CASE_ID}/toolbox`);
    await expect(row(page, "tcpdump-read")).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(shell(page, "Lab")).toHaveCount(1);
    await expect(row(page, "tcpdump-read").locator(".cmd-body")).toBeHidden();
    await expect(row(page, "tcpdump-read").locator("summary")).toContainText("−5");
  });

  await test.step("the side panel says how to open the lab: docker run and the Codespaces template", async () => {
    const box = page.locator(".lab-open");
    await expect(box).toContainText(`docker run -it --rm ghcr.io/incidentslab/lab-${CASE_ID}:v1`);
    await expect(box.getByRole("link", { name: "Codespaces template" })).toHaveAttribute("href", `https://github.com/IncidentsLab/lab-${CASE_ID}`);
  });

  await test.step("before the reveal: free syntax only, paid lab command absent", async () => {
    await shell(page, "Lab").check();
    await row(page, "tcpdump-read").locator("summary").click();
    const code = row(page, "tcpdump-read").locator("pre code");
    await expect(code).toContainText("<capture.pcap>");
    await expect(row(page, "tcpdump-read").locator(".lab-note")).toBeVisible();
    // DNS items have Bash and PowerShell but no lab variant: the row says it shows Bash.
    await row(page, "dig-answers").locator("summary").click();
    await expect(row(page, "dig-answers").locator(".cmd-shell-note")).toBeVisible();
    await expect(row(page, "dig-answers").locator(".lab-note")).toHaveCount(0);
    expect(await page.content()).not.toContain(PAID_LAB);
    const progress = await page.request.get(`/api/cases/${CASE_ID}/progress`);
    expect(await progress.text()).not.toContain("pcap/app-03_large-request.pcap");
  });

  await test.step("arrow keys move across the shell switch and every row follows", async () => {
    await shell(page, "Bash").check();
    await expect(row(page, "dig-answers").locator(".cmd-shell-note")).toBeHidden();
    await shell(page, "Bash").press("ArrowDown");
    await expect(shell(page, "PowerShell")).toBeFocused();
    await expect(shell(page, "PowerShell")).toBeChecked();
    await expect(row(page, "dig-answers").locator("pre code")).not.toContainText("dig ");
    await page.keyboard.press("ArrowDown");
    await expect(shell(page, "Lab")).toBeChecked();
    await expect(row(page, "tcpdump-read").locator(".lab-note")).toBeVisible();
  });

  await test.step("one reveal unlocks the lab command at the single charge; the row stays open at Copy", async () => {
    await row(page, "tcpdump-read").getByRole("button", { name: /reveal full command/i }).click();
    await page.getByRole("button", { name: /^yes, spend 5 pts/i }).click();
    await expect(row(page, "tcpdump-read")).toHaveClass(/is-revealed/);
    await expect(row(page, "tcpdump-read")).toHaveAttribute("open", "");
    await expect(row(page, "tcpdump-read").locator(".btn-copy")).toBeFocused();
    await expect(row(page, "tcpdump-read").locator("pre code")).toHaveText(PAID_LAB);
    const progress = (await (await page.request.get(`/api/cases/${CASE_ID}/progress`)).json()) as {
      progress: { stages: Record<string, { commandsRevealed: number }> };
    };
    expect(progress.progress.stages["q1"]?.commandsRevealed).toBe(1);
  });

  await test.step("\"This stage\" narrows the list; / focuses the filter but never while typing", async () => {
    const chip = page.getByRole("button", { name: /^This stage \(\d+\)$/ });
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".tb-count")).toContainText(/^\d+ of 39 commands$/);
    await expect(row(page, "dig-answers")).toBeHidden();
    await chip.click();
    await expect(row(page, "dig-answers")).toBeVisible();
    await page.locator(".toolbox-page h1").click();
    await page.keyboard.press("/");
    const filter = page.getByRole("searchbox", { name: "Filter commands" });
    await expect(filter).toBeFocused();
    await page.keyboard.type("dig/");
    await expect(filter).toHaveValue("dig/");
  });

  await test.step("a case without lab variants has no Lab choice", async () => {
    await page.goto("/#/case/3am-outage/toolbox");
    await expect(page.locator(".tool-list .cmd").first()).toBeVisible();
    await expect(shell(page, "Lab")).toHaveCount(0);
  });

  expect(pageErrors).toEqual([]);
});

test("toolbox load error offers Retry, which reloads in place", async ({ page, request }) => {
  const username = randomUsername("retry");
  const reg = await request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(reg.status()).toBe(201);
  await approveAccount(request, username);
  expect((await page.request.post("/api/auth/login", { data: { username, password: PASSWORD } })).status()).toBe(200);

  let failing = true;
  await page.route(`**/api/cases/${CASE_ID}/progress**`, async (route) => {
    if (failing) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
    else await route.fallback();
  });
  await page.goto(`/#/case/${CASE_ID}/toolbox`);
  const retry = page.getByRole("alert").getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  failing = false;
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(page.locator(".toolbox-page .notice").first()).toContainText(/start the case/i);
});
