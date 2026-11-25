// Tiny router: maps method + path to controller calls. Every dispatch is wrapped so nothing escapes as a crash.
import { AdminController } from "./controllers/AdminController.ts";
import { PlayerController } from "./controllers/PlayerController.ts";
import { errorResponse, toErrorResponse } from "./controllers/http.ts";
import { loadCaseConfig, loadSecrets } from "./domain/config.ts";
import type { CaseConfig, Secrets } from "./domain/types.ts";
import type { PlayerRepository } from "./repositories/PlayerRepository.ts";
import { AdminAuthService } from "./services/AdminAuthService.ts";
import { PlayerService } from "./services/PlayerService.ts";

export type AppDeps = {
  readonly repository: PlayerRepository;
  readonly secrets?: Secrets;
  readonly caseConfig?: CaseConfig;
  readonly adminKey: () => string | undefined; // read per request so env changes apply
};

export type App = { handle(req: Request, ip: string): Promise<Response> };

export const createApp = (deps: AppDeps): App => {
  const playerService = new PlayerService({
    repository: deps.repository,
    secrets: deps.secrets ?? loadSecrets(),
    caseConfig: deps.caseConfig ?? loadCaseConfig(),
  });
  const players = new PlayerController(playerService);

  const route = async (req: Request, ip: string): Promise<Response> => {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    const method = req.method.toUpperCase();
    const admin = new AdminController(playerService, new AdminAuthService(deps.adminKey()));

    const routes: Record<string, Partial<Record<string, () => Promise<Response>>>> = {
      "/api/players": { POST: () => players.create(req, ip) },
      "/api/me": { GET: () => players.me(req) },
      "/api/setup-done": { POST: () => players.setupDone(req) },
      "/api/answer": { POST: () => players.answer(req) },
      "/api/hint": { POST: () => players.hint(req) },
      "/api/reveal": { POST: () => players.reveal(req) },
      "/api/debrief": { GET: () => players.debrief(req) },
      "/api/admin/players": { GET: () => admin.listPlayers(req) },
      "/api/admin/reset": { POST: () => admin.reset(req) },
    };

    const exact = routes[path];
    if (exact) {
      const handler = exact[method];
      return handler ? handler() : errorResponse(405, "method not allowed");
    }
    const deleteMatch = /^\/api\/admin\/players\/([^/]+)$/.exec(path);
    if (deleteMatch) {
      return method === "DELETE" ? admin.deletePlayer(req, decodeURIComponent(deleteMatch[1] ?? "")) : errorResponse(405, "method not allowed");
    }
    return errorResponse(404, "not found");
  };

  return {
    async handle(req: Request, ip: string): Promise<Response> {
      try {
        return await route(req, ip);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  };
};
