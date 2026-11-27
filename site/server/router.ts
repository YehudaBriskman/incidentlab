// Tiny router: maps method + path to controller calls. Every dispatch is wrapped so nothing escapes as a crash.
import { AdminController } from "./controllers/AdminController.ts";
import { AuthorController } from "./controllers/AuthorController.ts";
import { ClassController } from "./controllers/ClassController.ts";
import { ClassService } from "./services/ClassService.ts";
import { ClassBoardService } from "./services/ClassBoardService.ts";
import { answerFingerprint } from "../shared/answer-fingerprint.ts";
import { AuthController } from "./controllers/AuthController.ts";
import { ContentController } from "./controllers/ContentController.ts";
import { GameController } from "./controllers/GameController.ts";
import { GuestController } from "./controllers/GuestController.ts";
import { errorResponse, toErrorResponse } from "./controllers/http.ts";
import type { Secrets } from "./domain/types.ts";
import { AuditRepository, EventRepository, FirstBloodRepository, SettingsRepository } from "./repositories/config-repositories.ts";
import { InMemoryByteStore } from "./repositories/ByteStore.ts";
import type { ByteStore } from "./repositories/ByteStore.ts";
import { CaseRepository, EvidenceChunkRepository } from "./repositories/case-repository.ts";
import type { KvStore } from "./repositories/KvStore.ts";
import { createRepositories } from "./repositories/repositories.ts";
import { AccountAdminService } from "./services/AccountAdminService.ts";
import { AdminAuthService } from "./services/AdminAuthService.ts";
import { AuditService } from "./services/AuditService.ts";
import { AuthService } from "./services/AuthService.ts";
import { CaseAccessService } from "./services/CaseAccessService.ts";
import { isLiveVersion } from "./services/evidenceStream.ts";
import { CaseSecretsProvider } from "./services/CaseSecretsProvider.ts";
import { CaseService } from "./services/CaseService.ts";
import { EvidenceService } from "./services/evidenceStream.ts";
import { EventService } from "./services/EventService.ts";
import { GameService } from "./services/GameService.ts";
import { GlobalBoardService } from "./services/GlobalBoardService.ts";
import { ScoreService } from "./services/ScoreService.ts";
import { GuestService } from "./services/GuestService.ts";
import { RateLimiter } from "./services/RateLimiter.ts";
import { ScheduleService } from "./services/ScheduleService.ts";
import { StatsService } from "./services/StatsService.ts";
import type { BoardPlayer } from "./services/StatsService.ts";
import { BoardCache } from "./services/BoardCache.ts";
import { TrashService } from "./services/TrashService.ts";
import { TrashRepository } from "./repositories/trash-repository.ts";
import { UploadRepository } from "./repositories/upload-repository.ts";
import { AuthorAuthService } from "./services/AuthorAuthService.ts";
import { CaseAuthoringService } from "./services/CaseAuthoringService.ts";
import { CaseUploadService } from "./services/CaseUploadService.ts";
import type { CachePurger } from "./services/CachePurger.ts";

export type AppDeps = {
  readonly store: KvStore;
  /** evidence bytes on the same Blobs store; api.mts always passes one, tests may leave it out */
  readonly bytes?: ByteStore;
  /**
   * Answer keys served next to the DB cases. Tests only: production passes none, so every released case,
   * answer key, hint text and command comes from the DB (#68). The pipeline's generated/secrets.json is a
   * build artefact for the checks and is never imported by the function.
   */
  readonly staticSecrets?: Secrets;
  readonly adminKey: () => string | undefined; // read per request so env changes apply
  readonly now?: () => Date;
  /** CDN purge after instructor writes (api.mts passes Netlify's); tests and the local server use the no-op. */
  readonly cachePurger?: CachePurger;
};

export type App = { handle(req: Request, ip: string): Promise<Response> };

type Handler = () => Promise<Response>;
type MethodTable = Partial<Record<string, Handler>>;

export const createApp = (deps: AppDeps): App => {
  const now = deps.now ?? (() => new Date());
  const staticSecrets: Secrets = deps.staticSecrets ?? { cases: {} };
  const repos = createRepositories(deps.store);
  const caseRepo = new CaseRepository(deps.store);
  const bytes = deps.bytes ?? new InMemoryByteStore();
  const chunkRepo = new EvidenceChunkRepository(bytes);
  const evidence = new EvidenceService({ cases: caseRepo, chunks: chunkRepo });
  const cases = new CaseService({ cases: caseRepo, evidence });
  // Answer keys: the DB-published cases (refreshed before each request, see handle), plus test fixtures if any.
  const secrets = new CaseSecretsProvider({ bundled: staticSecrets, source: cases, now });
  const settingsRepo = new SettingsRepository(deps.store);
  const firstBlood = new FirstBloodRepository(deps.store);

  const limiter = new RateLimiter(repos.rateLimits, now);
  const auth = new AuthService({ repos, settings: settingsRepo, limiter, adminKey: deps.adminKey, now });
  const events = new EventService({ events: new EventRepository(deps.store), settings: settingsRepo, now, purger: deps.cachePurger });
  const schedule = new ScheduleService({ repository: repos.schedule, releasedCaseIds: () => Object.keys(secrets.cases), now, purger: deps.cachePurger });
  // The global board's opted-in players, shared for a few seconds (#185); every writer that changes them clears it.
  const boardCache = new BoardCache<BoardPlayer[]>(() => now().getTime());
  const clearBoard = (): void => boardCache.clear();
  const scores = new ScoreService({ repos, caseIds: () => Object.keys(secrets.cases), onChange: clearBoard });
  const board = new GlobalBoardService({ repos, scores, purger: deps.cachePurger, now, onChange: clearBoard });
  // GameService reads private cases too (#184); GameController checks access before every call.
  const game = new GameService({ repository: repos.progress, firstBlood, secrets: secrets.playable, scores, now });
  const stats = new StatsService({ repos, secrets, privateCaseIds: () => secrets.privateCaseIds(), now, boardCache });
  const trashRepo = new TrashRepository(deps.store);
  const trash = new TrashService({ trash: trashRepo, repos, cases: caseRepo, scores, board, now });
  const accounts = new AccountAdminService({ repos, firstBlood, game, stats, trash, trashRepo, scores, now, onBoardChange: clearBoard });
  const audit = new AuditService({ repository: new AuditRepository(deps.store), repos, now });

  // Static (test-fixture) cases: only the admin may upload their ids, and their answer key is the drift
  // baseline until a DB version of the case is published. Empty in production: ownership of the DB meta
  // protects every stored case id, and the published version is the drift baseline.
  const bundledFingerprints = new Map<string, Promise<string>>();
  const bundledFingerprint = (caseId: string): Promise<string | null> => {
    const sealed = Object.entries(staticSecrets.cases).find(([id]) => id === caseId)?.[1];
    if (!sealed) return Promise.resolve(null);
    let found = bundledFingerprints.get(caseId);
    if (!found) bundledFingerprints.set(caseId, (found = answerFingerprint(sealed)));
    return found;
  };
  const reservedIds = new Set(Object.keys(staticSecrets.cases));
  const caseUploads = new CaseUploadService({
    uploads: new UploadRepository({ kv: deps.store, bytes }), cases: caseRepo, chunks: chunkRepo, limiter, bundledFingerprint, reservedIds: () => reservedIds, now,
  });
  // A live private case's classes: class admins may assign it to their class only when its author did (#184).
  const privateCaseClasses = async (caseId: string): Promise<readonly string[] | null> => {
    const meta = (await caseRepo.getMeta(caseId))?.data;
    return meta && meta.visibility === "private" && meta.publishedVersion !== null && isLiveVersion(meta, meta.publishedVersion) ? meta.classIds : null;
  };
  const classes = new ClassService({ repos, limiter, releasedCaseIds: () => Object.keys(secrets.cases), privateCaseClasses, now, purger: deps.cachePurger });
  const access = new CaseAccessService({ cases, classes, secrets, auth });
  const authoring = new CaseAuthoringService({ cases: caseRepo, progress: repos.progress, accounts: repos.accounts, classes, trash, bundledFingerprint, now });

  const authController = new AuthController({ auth, schedule, stats, events, board, access });
  const gameController = new GameController({ auth, game, access });
  const guestController = new GuestController({ guests: new GuestService({ repos, auth, limiter, now }) });
  const contentController = new ContentController({ cases, access });
  const adminGuard = new AdminAuthService({ adminKey: deps.adminKey, auth });
  const adminController = new AdminController({ accounts, schedule, stats, events, audit, trash, guard: adminGuard, now });
  const authorController = new AuthorController({
    guard: new AuthorAuthService({ admin: adminGuard, auth }), uploads: caseUploads, authoring, audit,
    onPublishedChange: () => secrets.refresh(true), // this instance plays the new version at once; others within SECRETS_REFRESH_MS
  });

  const classController = new ClassController({
    classes,
    boards: new ClassBoardService({ repos, game, publicCaseIds: () => Object.keys(secrets.cases), now }),
    auth, guard: adminGuard, audit,
  });

  const route = (req: Request, ip: string): MethodTable | null => {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    const exact: Record<string, MethodTable> = {
      "/api/auth/register": { POST: () => authController.register(req, ip) },
      "/api/auth/login": { POST: () => authController.login(req, ip) },
      "/api/auth/recover": { POST: () => authController.recover(req, ip) },
      "/api/auth/logout": { POST: () => authController.logout(req) },
      "/api/auth/upgrade": { POST: () => guestController.upgrade(req, ip) },
      "/api/guest": { POST: () => guestController.start(req, ip) },
      "/api/me": { GET: () => authController.me(req) },
      "/api/session": { GET: () => authController.session(req) },
      "/api/me/stats": { GET: () => authController.myStats(req) },
      "/api/me/password": { POST: () => authController.changePassword(req) },
      "/api/me/board": { PUT: () => authController.setBoard(req) },
      "/api/me/recovery-code": { POST: () => authController.regenerateRecoveryCode(req) },
      "/api/me/cases": { GET: () => contentController.mine(req) },
      "/api/admin/reviews": { GET: () => authorController.reviews(req) },
      "/api/today": { GET: () => authController.today() },
      "/api/event": { GET: () => authController.event() },
      "/api/leaderboard": { GET: () => authController.leaderboard(req) },
      "/api/cases": { GET: () => contentController.catalog(req) },
      "/api/classes": { GET: () => classController.mine(req), POST: () => classController.create(req) },
      "/api/classes/join": { POST: () => classController.join(req, ip) },
      "/api/admin/classes": { GET: () => classController.adminList(req) },
      "/api/admin/accounts": { GET: () => adminController.listAccounts(req) },
      "/api/admin/users": { GET: () => adminController.listUsers(req) },
      "/api/admin/accounts/approve-all": { POST: () => adminController.approveAll(req) },
      "/api/admin/progress": { GET: () => adminController.progress(req) },
      "/api/admin/reset": { POST: () => adminController.reset(req) },
      "/api/admin/schedule": { GET: () => adminController.getSchedule(req), PUT: () => adminController.putSchedule(req) },
      "/api/admin/stats": { GET: () => adminController.caseStats(req) },
      "/api/admin/settings": { GET: () => adminController.getSettings(req), PUT: () => adminController.putSettings(req) },
      "/api/admin/event": { GET: () => adminController.getEvent(req), PUT: () => adminController.putEvent(req) },
      "/api/admin/export.csv": { GET: () => adminController.exportCsv(req) },
      "/api/admin/audit": { GET: () => adminController.auditLog(req) },
      "/api/admin/trash": { GET: () => adminController.listTrash(req) },
      "/api/author/uploads": { POST: () => authorController.createUpload(req) },
      "/api/author/cases": { GET: () => authorController.listCases(req) },
    };
    const found = exact[path];
    if (found) return found;

    const segments = path.split("/").slice(1).map((s) => decodeURIComponent(s)); // ["api", ...]
    const [api, area, first, second] = segments;
    if (api !== "api") return null;

    if (area === "cases" && first !== undefined && segments.length === 4) {
      const caseId = first;
      const table: Record<string, MethodTable> = {
        // public and cacheable (no session); every other action here needs an approved player
        content: { GET: () => contentController.content(req, caseId) },
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
    if (area === "classboard" && first !== undefined && segments.length === 3) {
      const token = first;
      return { GET: () => classController.board(req, token) };
    }
    if (area === "classes" && first !== undefined) {
      const classId = first;
      const [, , , , third, fourth] = segments;
      if (segments.length === 3) return { GET: () => classController.detail(req, classId), PATCH: () => classController.update(req, classId) };
      if (segments.length === 4 && second === "archive") return { POST: () => classController.archive(req, classId) };
      if (segments.length === 4 && second === "restore") return { POST: () => classController.restore(req, classId) };
      if (segments.length === 4 && second === "leave") return { POST: () => classController.leave(req, classId) };
      if (segments.length === 4 && second === "members") return { GET: () => classController.members(req, classId) };
      if (segments.length === 4 && second === "progress") return { GET: () => classController.progress(req, classId) };
      if (segments.length === 5 && second === "join-code" && third === "rotate") return { POST: () => classController.rotateJoinCode(req, classId) };
      if (segments.length === 5 && second === "board-token" && third === "rotate") return { POST: () => classController.rotateBoardToken(req, classId) };
      if (segments.length === 6 && second === "members" && third !== undefined) {
        const accountId = third;
        if (fourth === "approve") return { POST: () => classController.approve(req, classId, accountId) };
        if (fourth === "remove") return { POST: () => classController.remove(req, classId, accountId) };
        if (fourth === "role") return { POST: () => classController.setRole(req, classId, accountId) };
      }
      return null;
    }
    if (area === "admin" && first === "classes" && second !== undefined && segments.length === 5 && segments[4] === "limits") {
      return { PUT: () => classController.setLimits(req, second) };
    }
    if (area === "author" && first === "uploads" && second !== undefined) {
      const [, , , , action, a, b] = segments;
      if (segments.length === 5 && action === "finalize") return { POST: () => authorController.finalize(req, second) };
      if (segments.length === 6 && action === "parts" && a !== undefined) return { PUT: () => authorController.putPart(req, second, a) };
      if (segments.length === 7 && action === "chunks" && a !== undefined && b !== undefined) {
        return { PUT: () => authorController.putChunk(req, second, a, b) };
      }
      return null;
    }
    if (area === "author" && first === "cases" && second !== undefined) {
      if (segments.length === 4) return { DELETE: () => authorController.remove(req, second) };
      if (segments.length === 5 && segments[4] === "publish") return { POST: () => authorController.publish(req, second) };
      if (segments.length === 5 && segments[4] === "restore") return { POST: () => authorController.restore(req, second) };
      if (segments.length === 5 && segments[4] === "submit-review") return { POST: () => authorController.submitReview(req, second) };
      if (segments.length === 5 && segments[4] === "classes") return { PUT: () => authorController.setClasses(req, second) };
      return null;
    }
    if (area === "admin" && first === "cases" && second !== undefined && segments.length === 5 && segments[4] === "review") {
      return { POST: () => authorController.review(req, second) };
    }
    if (area === "admin" && first === "accounts" && second !== undefined) {
      const action = segments[4];
      if (segments.length === 4) return { DELETE: () => adminController.deleteAccount(req, second) };
      if (segments.length === 5 && action === "approve") return { POST: () => adminController.approve(req, second) };
      if (segments.length === 5 && action === "reject") return { POST: () => adminController.reject(req, second) };
      if (segments.length === 5 && action === "role") return { PUT: () => adminController.setRole(req, second) };
      if (segments.length === 5 && action === "class-limit") return { PUT: () => adminController.setClassLimit(req, second) };
      if (segments.length === 5 && action === "reset-password") return { POST: () => adminController.resetPassword(req, second) };
    }
    if (area === "admin" && first === "trash" && second !== undefined && segments.length === 5 && segments[4] === "restore") {
      return { POST: () => adminController.restoreTrash(req, second) };
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
        await secrets.refresh();
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
