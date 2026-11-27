// Overlay system (#61): the shared confirm, menu and toast primitives in site/src/lib/overlay.ts, driven
// through the admin dashboard by keyboard. Every test runs in English at 1280px and in Hebrew (RTL) at 390px.
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, adminHeaders, approveAccount, randomUsername, searchUsers } from "./support";

const PASSWORD = "e2e-password-123";

// ---- selectors: keep every UI hook here so UI changes need edits in one place ----------------
const ui = {
  username: (p: Page) => p.locator("#auth-username"),
  password: (p: Page) => p.locator("#auth-password"),
  signInSubmit: (p: Page) => p.locator("form button[type=submit]").first(),
  search: (p: Page) => p.locator("input.admin-search"),
  actionsFor: (p: Page, name: string) => p.locator(`button[aria-haspopup="menu"][aria-label*="${name}"]:visible`).first(),
  menu: (p: Page) => p.getByRole("menu"),
  menuItems: (p: Page) => p.getByRole("menu").getByRole("menuitem"),
  confirm: (p: Page) => p.getByRole("alertdialog"),
  typedName: (p: Page) => p.getByRole("alertdialog").locator("input.ov-typed-input"),
  confirmOk: (p: Page) => p.getByRole("alertdialog").locator('button[data-action="ok"]'),
  toast: (p: Page, tone: string) => p.locator(`.toast-host .toast[data-tone="${tone}"]`),
};

const VARIANTS = [
  { name: "EN 1280", lang: "en", width: 1280, height: 900, dir: "ltr" },
  { name: "HE 390", lang: "he", width: 390, height: 844, dir: "rtl" },
] as const;

async function createPlayer(request: APIRequestContext, prefix: string): Promise<string> {
  const username = randomUsername(prefix);
  const reg = await request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(reg.status(), await reg.text()).toBe(201);
  // The admin account list is cached for a moment: wait until the new sign-up shows up in it.
  await expect
    .poll(async () => {
      const res = await request.get("/api/admin/accounts", { headers: adminHeaders });
      const { accounts } = (await res.json()) as { accounts: Array<{ username: string }> };
      return accounts.some((a) => a.username === username);
    })
    .toBe(true);
  await approveAccount(request, username);
  return username;
}

async function openAdminAccounts(page: Page, lang: string, username: string): Promise<void> {
  await page.goto("/");
  await page.evaluate((l) => localStorage.setItem("il.lang", l), lang);
  await page.goto("/#/login");
  await page.reload(); // a hash-only navigation keeps the page: reload so the language applies
  await ui.username(page).fill(ADMIN_USERNAME);
  await ui.password(page).fill(ADMIN_KEY);
  await ui.signInSubmit(page).click();
  await page.waitForURL((url) => !url.hash.startsWith("#/login"));
  await page.goto("/#/admin?tab=accounts");
  await searchUsers(page, username);
  await expect(ui.actionsFor(page, username)).toBeVisible();
}

/** True when the focused element is inside `container`. */
async function focusInside(container: Locator): Promise<boolean> {
  return container.evaluate((el) => el.contains(document.activeElement));
}

for (const v of VARIANTS) {
  test.describe(v.name, () => {
    test.use({ viewport: { width: v.width, height: v.height } });

    test("delete-account confirm: focus, Tab trap, Escape, typed name", async ({ page, request }) => {
      const username = await createPlayer(request, "e2eov");
      await openAdminAccounts(page, v.lang, username);
      await expect(page.locator("html")).toHaveAttribute("dir", v.dir);
      const trigger = ui.actionsFor(page, username);

      const openDeleteConfirm = async (): Promise<void> => {
        await trigger.focus();
        await page.keyboard.press("Enter");
        await expect(ui.menu(page)).toBeVisible();
        await page.keyboard.press("End"); // Delete is the last item
        await page.keyboard.press("Enter");
        await expect(ui.confirm(page)).toBeVisible();
      };

      await test.step("focus lands in the dialog, on the name field", async () => {
        await openDeleteConfirm();
        await expect(ui.typedName(page)).toBeFocused();
        await expect(page.locator("html")).toHaveClass(/has-modal/);
      });

      await test.step("Tab and Shift+Tab stay inside the dialog", async () => {
        const dialog = ui.confirm(page);
        for (let i = 0; i < 6; i++) {
          await page.keyboard.press("Tab");
          expect(await focusInside(dialog), `Tab #${i + 1} stays in the dialog`).toBe(true);
        }
        for (let i = 0; i < 6; i++) {
          await page.keyboard.press("Shift+Tab");
          expect(await focusInside(dialog), `Shift+Tab #${i + 1} stays in the dialog`).toBe(true);
        }
      });

      await test.step("Escape cancels and focus returns to the trigger", async () => {
        await page.keyboard.press("Escape");
        await expect(ui.confirm(page)).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await expect(page.locator("html")).not.toHaveClass(/has-modal/);
      });

      await test.step("the confirm button turns on only for the exact name", async () => {
        await openDeleteConfirm();
        const ok = ui.confirmOk(page);
        await expect(ok).toBeDisabled();
        await page.keyboard.type(username.slice(0, -1));
        await expect(ok).toBeDisabled();
        await page.keyboard.type(username.slice(-1).toUpperCase() === username.slice(-1) ? "x" : username.slice(-1).toUpperCase());
        await expect(ok).toBeDisabled();
        await page.keyboard.press("Backspace");
        await page.keyboard.type(username.slice(-1));
        await expect(ok).toBeEnabled();
        await page.keyboard.press("Enter");
        await expect(ui.confirm(page)).toHaveCount(0);
      });

      await test.step("the account is gone and a success toast appears, then dismisses itself", async () => {
        const toast = ui.toast(page, "success").filter({ hasText: username });
        await expect(toast).toBeVisible();
        await expect(ui.actionsFor(page, username)).toHaveCount(0);
        await expect(toast).toHaveCount(0, { timeout: 12_000 });
      });
    });

    test("row menu by keyboard: arrows, Home/End, typeahead, Escape", async ({ page, request }) => {
      const username = await createPlayer(request, "e2emenu");
      await openAdminAccounts(page, v.lang, username);
      const trigger = ui.actionsFor(page, username);
      const items = ui.menuItems(page);

      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await expect(ui.menu(page)).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      const count = await items.count();
      expect(count).toBeGreaterThanOrEqual(3);
      await expect(items.first()).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(items.nth(1)).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(items.first()).toBeFocused();
      await page.keyboard.press("ArrowUp"); // wraps
      await expect(items.last()).toBeFocused();
      await page.keyboard.press("Home");
      await expect(items.first()).toBeFocused();
      await page.keyboard.press("End");
      await expect(items.last()).toBeFocused();

      // Typeahead: the first letter of the second item's label moves to an item starting with it.
      const label = ((await items.nth(1).textContent()) ?? "").trim();
      await page.keyboard.press("Home");
      // A keydown carrying the letter as `key`, as a Hebrew layout sends it (keyboard.type inserts text
      // without a keydown for characters outside the US layout).
      await page.evaluate((ch) => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true })), label.slice(0, 1));
      const focusedLabel = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
      expect(focusedLabel.toLocaleLowerCase().startsWith(label.slice(0, 1).toLocaleLowerCase())).toBe(true);

      await page.keyboard.press("Escape");
      await expect(ui.menu(page)).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");

      // ArrowUp opens on the last item; Tab closes the menu.
      await page.keyboard.press("ArrowUp");
      await expect(items.last()).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(ui.menu(page)).toBeHidden();
    });

    test("toasts: success dismisses itself, an error stays and repeats count up", async ({ page }) => {
      await page.goto("/");
      await page.evaluate((l) => localStorage.setItem("il.lang", l), v.lang);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("dir", v.dir);
      // An uncaught error reaches the global safety net in main.ts, which raises an error toast.
      const throwLater = (): Promise<void> => page.evaluate(() => void window.setTimeout(() => { throw new Error("e2e overlay toast"); }, 0));
      await throwLater();
      const error = ui.toast(page, "error");
      await expect(error).toHaveCount(1);
      await throwLater();
      await expect(error).toHaveCount(1); // the same message never stacks
      await expect(error.locator(".toast-count")).toHaveText("×2");
      await page.waitForTimeout(7_000); // longer than the success timeout
      await expect(error).toBeVisible();
      // Inside the viewport at this width (no horizontal overflow from the host).
      const box = await error.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= v.width).toBe(true);
      await error.getByRole("button").last().click(); // dismiss
      await expect(error).toHaveCount(0);
    });
  });
}
