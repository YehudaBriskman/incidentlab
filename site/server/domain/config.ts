// Loads and validates the generated secrets (answer keys, debriefs, points) for every released case.
import secretsJson from "../generated/secrets.json" with { type: "json" };
import { SecretsSchema } from "./types.ts";
import type { Secrets } from "./types.ts";

export const loadSecrets = (): Secrets => SecretsSchema.parse(secretsJson);
