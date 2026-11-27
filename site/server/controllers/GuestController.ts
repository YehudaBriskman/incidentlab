import { z } from "zod";
import { UpgradeRequestSchema } from "../../shared/contract.ts";
import type { GuestService } from "../services/GuestService.ts";
import { json, parseBody, sessionCookie, sessionToken, withCookie } from "./http.ts";

const EmptyBodySchema = z.object({}).strict();

/** Guest play (#176): start a guest session, and upgrade it to a full account. Personalised: always no-store. */
export class GuestController {
  private readonly guests: GuestService;

  constructor(deps: { guests: GuestService }) {
    this.guests = deps.guests;
  }

  async start(req: Request, ip: string): Promise<Response> {
    await parseBody(req, EmptyBodySchema);
    const { account, created, session } = await this.guests.start(sessionToken(req), ip);
    const res = json(created ? 201 : 200, { account });
    return session ? withCookie(res, sessionCookie(req, session)) : res;
  }

  async upgrade(req: Request, ip: string): Promise<Response> {
    const body = await parseBody(req, UpgradeRequestSchema);
    const { account, session, recoveryCode } = await this.guests.upgrade(sessionToken(req), { ...body, ip });
    return withCookie(json(200, { account, ...(recoveryCode === null ? {} : { recoveryCode }) }), sessionCookie(req, session));
  }
}
