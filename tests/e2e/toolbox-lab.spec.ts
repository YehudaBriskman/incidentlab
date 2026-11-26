// Toolbox lab variant (#149) and load-error Retry (#138): the Lab tab shows only on items with a lab variant,
// arrow keys move across all three tabs, the paid lab command is absent until the single reveal, and a failed
// progress load offers Retry.
import { expect, test, type Page } from "@playwright/test";
import { approveAccount, randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";
// Paid: the runnable lab command of tcpdump-read. It must never be on the page before the reveal.
const PAID_LAB = "tcpdump -nn -tttt -v -r pcap/app-03_large-request.pcap | head -n 20";

const card = (p: Page, toolId: string) => p.locator(`.tool-list [data-tool="${toolId}"]`);
const tab = (p: Page, toolId: string, name: string) => card(p, toolId).getByRole("tab", { name, exact: true });

test("Lab tab only where a lab variant exists; paid lab command only after the reveal", async ({ page, request }) => {
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

  await test.step("Lab tab on lab items only, and in the page-wide switch", async () => {
    await page.goto(`/#/case/${CASE_ID}/toolbox`);
    await expect(card(page, "tcpdump-read")).toBeVisible();
    await expect(tab(page, "tcpdump-read", "Lab")).toBeVisible();
    await expect(tab(page, "json-unique-field", "Lab")).toBeVisible();
    // DNS items have Bash and PowerShell but no lab variant.
    await expect(tab(page, "dig-answers", "PowerShell")).toBeVisible();
    await expect(tab(page, "dig-answers", "Lab")).toHaveCount(0);
    await expect(page.getByRole("radio", { name: "Lab", exact: true })).toHaveCount(1);
  });

  await test.step("before the reveal: free syntax only, paid lab command absent", async () => {
    await tab(page, "tcpdump-read", "Lab").click();
    const code = card(page, "tcpdump-read").locator("pre code");
    await expect(code).toContainText("<capture.pcap>");
    await expect(card(page, "tcpdump-read").locator(".lab-note")).toBeVisible();
    expect(await page.content()).not.toContain(PAID_LAB);
    const progress = await page.request.get(`/api/cases/${CASE_ID}/progress`);
    expect(await progress.text()).not.toContain("pcap/app-03_large-request.pcap");
  });

  await test.step("arrow keys move across the three tabs and wrap", async () => {
    await tab(page, "tcpdump-read", "Bash").click();
    await tab(page, "tcpdump-read", "Bash").press("ArrowRight");
    await expect(tab(page, "tcpdump-read", "PowerShell")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "tcpdump-read", "Lab")).toBeFocused();
    await expect(tab(page, "tcpdump-read", "Lab")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "tcpdump-read", "Bash")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "tcpdump-read", "Lab")).toBeFocused();
  });

  await test.step("one reveal unlocks the lab command at the single charge", async () => {
    await card(page, "tcpdump-read").getByRole("button", { name: /reveal full command/i }).click();
    await page.getByRole("button", { name: /^yes, spend 5 pts/i }).click();
    await expect(card(page, "tcpdump-read")).toHaveClass(/is-revealed/);
    await tab(page, "tcpdump-read", "Lab").click();
    await expect(card(page, "tcpdump-read").locator("pre code")).toHaveText(PAID_LAB);
    const progress = (await (await page.request.get(`/api/cases/${CASE_ID}/progress`)).json()) as {
      progress: { stages: Record<string, { commandsRevealed: number }> };
    };
    expect(progress.progress.stages["q1"]?.commandsRevealed).toBe(1);
  });

  await test.step("a case without lab variants has no Lab choice", async () => {
    await page.goto("/#/case/3am-outage/toolbox");
    await expect(page.locator(".tool-list .cmd").first()).toBeVisible();
    await expect(page.getByRole("tab", { name: "Lab", exact: true })).toHaveCount(0);
    await expect(page.getByRole("radio", { name: "Lab", exact: true })).toHaveCount(0);
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
