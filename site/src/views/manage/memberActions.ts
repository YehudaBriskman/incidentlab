// The members table's row actions: approve or reject a sign-up, ban (asks first: it signs the player out) or
// unban, the author role, the class limit (#185), a password reset with its one-time password dialog
// (lib/overlay.ts), and delete (typed name, then the dashboard's Undo). Shared by the table rows and the phone
// cards of manage/members.ts. Ban is the account's `rejected` status.
import { T } from "../../i18n/strings-tools";
import { toast, type MenuItem } from "../../lib/overlay";
import { CLASS_DEFAULTS, TRASH_RETENTION_DAYS, type AccountRecordRole, type AccountView, type UserStats } from "../../../shared/contract";
import { fmtInt } from "./format";
import type { ManageHost, Slot } from "./host";
import { limitDialog } from "./limitDialog";
import { showTemporaryPassword } from "./tempPassword";

export type MemberActionsApi = {
  setStatus(accountId: string, action: "approve" | "reject"): Promise<AccountView>;
  setRole(accountId: string, role: AccountRecordRole): Promise<AccountView>;
  /** Resolves to a one-time temporary password, shown once in a dialog. */
  resetPassword(accountId: string): Promise<string>;
  deleteAccount(accountId: string): Promise<void>;
  /** How many active classes the account may own; null = the site default. Optional: no menu item without it. */
  setClassLimit?(accountId: string, classLimit: number | null): Promise<number | null>;
};

export type MemberActionsOptions = {
  host: ManageHost;
  accounts: Slot<readonly UserStats[] | null>;
  api: MemberActionsApi;
  /** In-flight row actions, keyed "status:<accountId>" (rows show them as busy). */
  busy: Set<string>;
  /** Re-renders the section after an action. */
  rerender(): void;
  /** A delete went through: drop the account's UI state. */
  onDeleting?: (accountId: string) => void;
  /** Where focus goes when the deleted row's menu button is gone. */
  fallbackFocus(): HTMLElement;
  /** After a confirmed delete: the admin dashboard offers Undo from its trash. */
  onDeleted?: (account: UserStats) => Promise<void>;
};

export type MemberActions = {
  changeStatus(account: UserStats, action: "approve" | "reject"): Promise<void>;
  /** The row's "⋯" actions menu button. */
  menu(account: UserStats): HTMLButtonElement;
};

export function createMemberActions(opts: MemberActionsOptions): MemberActions {
  const { host } = opts;

  async function changeStatus(account: UserStats, action: "approve" | "reject"): Promise<void> {
    const busyKey = `status:${account.accountId}`;
    opts.busy.add(busyKey);
    opts.rerender();
    try {
      const updated = await opts.api.setStatus(account.accountId, action);
      const list = opts.accounts.get();
      if (list) opts.accounts.set(list.map((a) => (a.accountId === updated.id ? { ...a, status: updated.status } : a)));
      host.setBanner(null);
      host.refresh();
    } catch (err: unknown) {
      host.showActionError(err);
    } finally {
      opts.busy.delete(busyKey);
      if (opts.accounts.get()) opts.rerender();
    }
  }

  async function changeRole(account: UserStats, role: AccountRecordRole): Promise<void> {
    const busyKey = `status:${account.accountId}`;
    opts.busy.add(busyKey);
    opts.rerender();
    try {
      const updated = await opts.api.setRole(account.accountId, role);
      const list = opts.accounts.get();
      if (list) opts.accounts.set(list.map((a) => (a.accountId === updated.id && updated.role !== "admin" ? { ...a, role: updated.role } : a)));
    } catch (err: unknown) {
      host.showActionError(err);
    } finally {
      opts.busy.delete(busyKey);
      if (opts.accounts.get()) opts.rerender();
    }
  }

  /** Menu items for one account: status changes first, then the password reset, Delete last (danger). */
  function acctMenuItems(a: UserStats): MenuItem[] {
    const key = `acct:${a.accountId}`;
    const items: MenuItem[] = [];
    // Pending sign-ups are approved; banned accounts are unbanned (the same call: back to approved).
    if (a.status === "pending") items.push({ label: T().admApprove, run: () => void changeStatus(a, "approve") });
    if (a.status === "rejected") items.push({ label: T().admUnban, run: () => void changeStatus(a, "approve") });
    // Revoke signs the player out at once, so it asks first: approving again later can't bring the session back.
    if (a.status === "approved") {
      items.push({
        label: T().admRevoke,
        run: () =>
          void host.askConfirm({
            title: T().admRevokeTitle(a.username),
            body: T().admRevokeBody,
            confirmLabel: T().admRevokeConfirm,
            tone: "danger",
            returnFocus: () => host.menuTriggerEl(key),
          }).then((ok) => {
            if (ok) void changeStatus(a, "reject");
          }),
      });
    } else if (a.status === "pending") items.push({ label: T().admReject, run: () => void changeStatus(a, "reject") });
    // Guests can't author or own classes (they have no password to sign in with).
    if (a.kind !== "guest") {
      items.push(a.role === "author" ? { label: T().admRemoveAuthor, run: () => void changeRole(a, "player") } : { label: T().admMakeAuthor, run: () => void changeRole(a, "author") });
      const setClassLimit = opts.api.setClassLimit;
      if (setClassLimit) items.push({ label: T().admSetClassLimitItem, run: () => void editClassLimit(a, setClassLimit, key) });
    }
    items.push({
      label: T().admResetPwItem,
      run: () =>
        void host.askConfirm({
          title: T().admResetPwTitle(a.username),
          body: T().admResetPwBody,
          confirmLabel: T().admResetPwLabel(a.username),
          busyLabel: T().admResettingPw,
          tone: "primary",
          run: async () => {
            const password = await opts.api.resetPassword(a.accountId);
            void showTemporaryPassword(host, { username: a.username, password });
          },
          returnFocus: () => host.menuTriggerEl(key),
        }),
    });
    items.push({
      label: T().admDeleteItem,
      tone: "danger",
      run: () =>
        void host.askConfirm({
          title: T().admDeleteTitle(a.username),
          body: T().admDeleteBody(TRASH_RETENTION_DAYS),
          confirmLabel: T().admDeleteLabel(a.username),
          cancelLabel: T().admKeepAccount,
          busyLabel: T().admDeleting,
          tone: "danger",
          typedName: a.username,
          run: async () => {
            await opts.api.deleteAccount(a.accountId);
            opts.onDeleting?.(a.accountId);
            const list = opts.accounts.get();
            if (list) opts.accounts.set(list.filter((x) => x.accountId !== a.accountId));
            opts.rerender();
            host.refresh();
          },
          returnFocus: () => host.menuTriggerEl(key) ?? opts.fallbackFocus(),
        }).then(async (ok) => {
          if (!ok) return;
          await opts.onDeleted?.(a);
        }),
    });
    return items;
  }

  async function editClassLimit(a: UserStats, save: (id: string, limit: number | null) => Promise<number | null>, key: string): Promise<void> {
    const fallback = fmtInt(CLASS_DEFAULTS.OWNED_LIMIT);
    try {
      const saved = await limitDialog({
        title: T().admClassLimitTitle(a.username),
        label: T().admClassLimitLabel,
        help: T().admClassLimitHelp(fallback),
        value: a.classLimit,
        defaultValue: CLASS_DEFAULTS.OWNED_LIMIT,
        min: 0,
        max: CLASS_DEFAULTS.MAX_CLASS_LIMIT,
        allowDefault: true,
        save: async (value) => {
          await save(a.accountId, value);
        },
        returnFocus: () => host.menuTriggerEl(key),
      });
      if (saved === undefined || host.disposed()) return;
      const list = opts.accounts.get();
      if (list) opts.accounts.set(list.map((x) => (x.accountId === a.accountId ? { ...x, classLimit: saved } : x)));
      opts.rerender();
      toast({ tone: "success", text: T().admClassLimitSaved(a.username, saved === null ? fallback : fmtInt(saved)) });
    } catch (err: unknown) {
      host.showActionError(err);
    }
  }

  function menu(a: UserStats): HTMLButtonElement {
    return host.menuButton(T().admActionsFor(a.username), `acct:${a.accountId}`, () => acctMenuItems(a));
  }

  return { changeStatus, menu };
}
