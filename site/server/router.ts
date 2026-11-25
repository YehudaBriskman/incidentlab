// Tiny router: maps method + path to controller calls. Every dispatch is wrapped so nothing escapes as a crash.
import { AdminController } from "./controllers/AdminController.ts";
import { AuthController } from "./controllers/AuthController.ts";
import { GameController } from "./controllers/GameController.ts";
import { errorResponse, toErrorResponse } from "./controllers/http.ts";
import { loadSecrets } from "./domain/config.ts";
import type { Secrets } from "./domain/types.ts";
import { AuditRepository, EventRepository, FirstBloodRepository, SettingsRepository } from "./repositories/config-repositories.ts";
import type { KvStore } from "./repositories/KvStore.ts";
import { createRepositories } from "./repositories/repositories.ts";
import { AccountAdminService } from "./services/AccountAdminService.ts";
import { AdminAuthService } from "./services/AdminAuthService.ts";
import { AuditService } from "./services/AuditService.ts";
import { AuthService } from "./services/AuthService.ts";
import { EventService } from "./services/EventService.ts";
import { GameService } from "./services/GameService.ts";
import { RateLimiter } from "./services/RateLimiter.ts";
import { ScheduleService } from "./services/ScheduleService.ts";
import { StatsService } from "./services/StatsService.ts";

export type AppDeps = {
  readonly store: KvStore;
  readonly secrets?: Secrets;
  readonly adminKey: () => string | undefined; // read per request so env changes apply
  readonly now?: () => Date;
};

export type App = { handle(req: Request, ip: string): Promise<Response> };

type Handler = () => Promise<Response>;
type MethodTable = Partial<Record<string, Handler>>;

export const createApp = (deps: AppDeps): App => {
  const now = deps.now ?? (() => new Date());
  const secrets = deps.secrets ?? loadSecrets();
  const repos = createRepositories(deps.store);
  const settingsRepo = new SettingsRepository(deps.store);
  const firstBlood = new FirstBloodRepository(deps.store);

  const limiter = new RateLimiter(repos.rateLimits, now);
  const auth = new AuthService({ repos, settings: settingsRepo, limiter, adminKey: deps.adminKey, now });
  const events = new EventService({ events: new EventRepository(deps.store), settings: settingsRepo, now });
  const schedule = new ScheduleService({ repository: repos.schedule, releasedCaseIds: Object.keys(secrets.cases), now });
  const game = new GameService({ repository: repos.progress, firstBlood, secrets, schedule, events, now });
  const stats = new StatsService({ repos, secrets, now });
  const accounts = new AccountAdminService({ repos, firstBlood, game, stats, now });
  const audit = new AuditService({ repository: new AuditRepository(deps.store), now });

  const authController = new AuthController({ auth, schedule, stats, events });
  const gameController = new GameController({ auth, game });
  const adminController = new AdminController({
    accounts, schedule, stats, events, audit, guard: new AdminAuthService({ adminKey: deps.adminKey, auth }), now,
  });

  const route = (req: Request, ip: string): MethodTable | null => {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    const exact: Record<string, MethodTable> = {
      "/api/auth/register": { POST: () => authController.register(req, ip) },
      "/api/auth/login": { POST: () => authController.login(req, ip) },
      "/api/auth/logout": { POST: () => authController.logout(req) },
      "/api/me": { GET: () => authController.me(req) },
      "/api/me/stats": { GET: () => authController.myStats(req) },
      "/api/me/password": { POST: () => authController.changePassword(req) },
      "/api/today": { GET: () => authController.today() },
      "/api/event": { GET: () => authController.event() },
      "/api/leaderboard": { GET: () => authController.leaderboard(req) },
      "/api/admin/accounts": { GET: () => adminController.listAccounts(req) },
      "/api/admin/accounts/approve-all": { POST: () => adminController.approveAll(req) },
      "/api/admin/progress": { GET: () => adminController.progress(req) },
      "/api/admin/reset": { POST: () => adminController.reset(req) },
      "/api/admin/schedule": { GET: () => adminController.getSchedule(req), PUT: () => adminController.putSchedule(req) },
      "/api/admin/stats": { GET: () => adminController.caseStats(req) },
      "/api/admin/settings": { GET: () => adminController.getSettings(req), PUT: () => adminController.putSettings(req) },
      "/api/admin/event": { GET: () => adminController.getEvent(req), PUT: () => adminController.putEvent(req) },
      "/api/admin/export.csv": { GET: () => adminController.exportCsv(req) },
      "/api/admin/audit": { GET: () => adminController.auditLog(req) },
    };
    const found = exact[path];
    if (found) return found;

    const segments = path.split("/").slice(1).map((s) => decodeURIComponent(s)); // ["api", ...]
    const [api, area, first, second] = segments;
    if (api !== "api") return null;

    if (area === "cases" && first !== undefined && segments.length === 4) {
      const caseId = first;
      const table: Record<string, MethodTable> = {
        progress: { GET: () => gameController.progress(req, caseId) },
        "setup-done": { POST: () => gameController.setupDone(req, caseId) },
        answer: { POST: () => gameController.answer(req, caseId) },
        hint: { POST: () => gameController.hint(req, caseId) },
        "reveal-command": { POST: () => gameController.revealCommand(req, caseId) },
        reveal: { POST: () => gameController.reveal(req, caseId) },
        debrief: { GET: () => gameController.debrief(req, caseId) },
      };
      return table[second ?? ""] ?? null;
    }
    if (area === "admin" && first === "accounts" && second !== undefined) {
      const action = segments[4];
      if (segments.length === 4) return { DELETE: () => adminController.deleteAccount(req, second) };
      if (segments.length === 5 && action === "approve") return { POST: () => adminController.approve(req, second) };
      if (segments.length === 5 && action === "reject") return { POST: () => adminController.reject(req, second) };
      if (segments.length === 5 && action === "reset-password") return { POST: () => adminController.resetPassword(req, second) };
    }
    if (area === "admin" && first === "progress" && second !== undefined && segments.length === 5) {
      const caseId = segments[4] ?? "";
      return { DELETE: () => adminController.resetOne(req, second, caseId) };
    }
    return null;
  };

  return {
    async handle(req: Request, ip: string): Promise<Response> {
      try {
        const table = route(req, ip);
        if (!table) return errorResponse(404, "not found");
        const handler = table[req.method.toUpperCase()];
        return handler ? await handler() : errorResponse(405, "method not allowed");
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  };
};
