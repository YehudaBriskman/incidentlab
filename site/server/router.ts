// Tiny router: maps method + path to controller calls. Every dispatch is wrapped so nothing escapes as a crash.
import { AdminController } from "./controllers/AdminController.ts";
import { AuthController } from "./controllers/AuthController.ts";
import { GameController } from "./controllers/GameController.ts";
import { errorResponse, toErrorResponse } from "./controllers/http.ts";
import { loadSecrets } from "./domain/config.ts";
import type { Secrets } from "./domain/types.ts";
import type { KvStore } from "./repositories/KvStore.ts";
import { createRepositories } from "./repositories/repositories.ts";
import { AccountAdminService } from "./services/AccountAdminService.ts";
import { AdminAuthService } from "./services/AdminAuthService.ts";
import { AuthService } from "./services/AuthService.ts";
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
  const limiter = new RateLimiter(repos.rateLimits, now);
  const auth = new AuthService({ repos, limiter, now });
  const schedule = new ScheduleService({ repository: repos.schedule, releasedCaseIds: Object.keys(secrets.cases), now });
  const game = new GameService({ repository: repos.progress, secrets, schedule, now });
  const stats = new StatsService({ repos, secrets, now });
  const accounts = new AccountAdminService({ repos, game, now });

  const authController = new AuthController({ auth, schedule, stats });
  const gameController = new GameController({ auth, game });
  const adminController = new AdminController({ accounts, schedule, stats, auth: () => new AdminAuthService(deps.adminKey()), now });

  const route = (req: Request, ip: string): MethodTable | null => {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    const exact: Record<string, MethodTable> = {
      "/api/auth/register": { POST: () => authController.register(req, ip) },
      "/api/auth/login": { POST: () => authController.login(req, ip) },
      "/api/auth/logout": { POST: () => authController.logout(req) },
      "/api/me": { GET: () => authController.me(req) },
      "/api/me/stats": { GET: () => authController.myStats(req) },
      "/api/today": { GET: () => authController.today() },
      "/api/admin/accounts": { GET: () => adminController.listAccounts(req) },
      "/api/admin/progress": { GET: () => adminController.progress(req) },
      "/api/admin/reset": { POST: () => adminController.reset(req) },
      "/api/admin/schedule": { GET: () => adminController.getSchedule(req), PUT: () => adminController.putSchedule(req) },
      "/api/admin/stats": { GET: () => adminController.caseStats(req) },
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
