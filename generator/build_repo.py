#!/usr/bin/env python3
"""Build the fictional `shipfast-checkout` git repo for case `3am-outage`.

Outputs (all recreated on every run):
  build/repo/shipfast-checkout                              working git repo
  build/evidence/3am-outage/repo/shipfast-checkout.bundle   git bundle (--all, includes tags)
  build/truth/repo.json                                     answer key for q2/q4

Every commit has fixed author/committer identity and dates, and git is isolated from the
user's global/system config, so the resulting SHAs are identical on every run.
Run from the repo root: python3 generator/build_repo.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
import timeline as T  # noqa: E402

REPO_DIR: Path = T.BUILD / "repo" / "shipfast-checkout"
BUNDLE_PATH: Path = T.EVIDENCE_DIR / "repo" / "shipfast-checkout.bundle"
TRUTH_PATH: Path = T.TRUTH_DIR / "repo.json"
CLONE_CHECK_DIR: Path = T.BUILD / "_bundle_clone_check"

AUTHORS: tuple[str, ...] = ("dana.k", "amir.t", "yossi.b", "maya.r")
BAD_TAG = "v2.14.1"
DECOY_TAG = "v2.14.0"
PREV_TAG = "v2.13.4"
BAD_FILE = "src/validators/giftMessage.ts"
BAD_FUNCTION = "sanitizeGiftMessage"
FORBIDDEN_WORDS: tuple[str, ...] = ("backtracking",)

# Israel: IDT (+0300) until the last Sunday of October (2026-10-25 02:00 local), IST (+0200) after.
DST_END_LOCAL = datetime(2026, 10, 25, 2, 0, 0)


def tz_offset(local: datetime) -> str:
    return "+0300" if local < DST_END_LOCAL else "+0200"


def git_date(local: datetime) -> str:
    return f"{local.strftime('%Y-%m-%d %H:%M:%S')} {tz_offset(local)}"


def base_env() -> dict[str, str]:
    env: dict[str, str] = {
        k: v for k, v in os.environ.items() if not k.startswith("GIT_")
    }
    env.update(
        {
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
            "TZ": "UTC",
            "LC_ALL": "C",
        }
    )
    return env


GIT_FLAGS: list[str] = [
    "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false",
    "-c", "init.defaultBranch=main",
    "-c", "user.useConfigOnly=false",
    "-c", "core.autocrlf=false",
    "-c", "core.fileMode=true",
]


def git(args: list[str], cwd: Path, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        ["git", *GIT_FLAGS, *args],
        cwd=cwd,
        env=env if env is not None else base_env(),
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


# --------------------------------------------------------------------------------------------
# File contents
# --------------------------------------------------------------------------------------------

GITIGNORE = """node_modules/
dist/
coverage/
.env
*.log
"""

DOCKERIGNORE = """node_modules
dist
coverage
.git
test
"""

TSCONFIG = """{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
"""

JEST_CONFIG = """/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  collectCoverageFrom: ["src/**/*.ts"],
};
"""

README_V1 = """# shipfast-checkout

Cart and checkout API for the Shipfast storefront.

## Endpoints

| Method | Path              | Description                  |
|--------|-------------------|------------------------------|
| GET    | `/api/cart`       | Get the current cart         |
| POST   | `/api/cart/items` | Add an item to the cart      |
| POST   | `/api/checkout`   | Place an order               |
| GET    | `/healthz`        | Liveness probe               |

## Ownership

Team Checkout (#team-checkout). On-call rotation in PagerDuty: `checkout-primary`.
"""

README_DEV_SECTION = """
## Local development

```sh
npm ci
cp .env.example .env   # set DATABASE_URL
npm run dev            # ts-node-dev on :8080
npm test
```

Requires Node 20+ and a local Postgres (see `docker compose up db` in the infra repo).
"""

README_RELEASE_SECTION = """
## Releasing

1. Bump `version` in `package.json` and tag `vX.Y.Z` on `main`.
2. CI builds `registry.shipfast.example/checkout:<tag>`.
3. Argo rolls it out to `prod` (3 replicas, rolling update, maxUnavailable 1).
"""

ENV_EXAMPLE = """PORT=8080
DATABASE_URL=postgres://checkout:checkout@localhost:5432/shipfast
LOG_LEVEL=info
"""

LOGGER_V1 = """import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { svc: "checkout", version: process.env.APP_VERSION ?? "dev" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
"""

DB_V1 = """import { Pool } from "pg";
import { logger } from "./logger";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  logger.error({ err }, "db.pool.error");
});
"""

SERVER_V1 = """import express from "express";
import { logger } from "./lib/logger";

const app = express();
app.use(express.json({ limit: "100kb" }));

const port = Number(process.env.PORT ?? 8080);

app.listen(port, () => {
  logger.info({ port }, "server.start");
});
"""

CART_V1 = """import { Router, Request, Response } from "express";

export interface CartItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

const carts = new Map<string, CartItem[]>();

export const cartRouter = Router();

function customerId(req: Request): string {
  return String(req.header("x-customer-id") ?? "anonymous");
}

export function getCart(customer: string): CartItem[] {
  return carts.get(customer) ?? [];
}

cartRouter.get("/", (req: Request, res: Response) => {
  res.json({ items: getCart(customerId(req)) });
});

cartRouter.post("/items", (req: Request, res: Response) => {
  const { sku, qty, unitPrice } = req.body ?? {};
  if (typeof sku !== "string" || typeof qty !== "number") {
    return res.status(400).json({ error: "sku and qty are required" });
  }
  const items = getCart(customerId(req));
  items.push({ sku, qty, unitPrice: Number(unitPrice ?? 0) });
  carts.set(customerId(req), items);
  res.status(201).json({ items });
});
"""

CHECKOUT_V1 = """import { Router, Request, Response } from "express";
import { getCart } from "./cart";

export const checkoutRouter = Router();

checkoutRouter.post("/", (req: Request, res: Response) => {
  const customer = String(req.header("x-customer-id") ?? "anonymous");
  const items = getCart(customer);
  if (items.length === 0) {
    return res.status(400).json({ error: "cart is emtpy" });
  }
  const total = items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
  res.status(201).json({ status: "paid", total });
});
"""

ADDRESS_V1 = """export class ValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface Address {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  country: string;
}

const COUNTRY_RE = /^[A-Z]{2}$/;

export function validateAddress(input: unknown): Address {
  if (typeof input !== "object" || input === null) {
    throw new ValidationError("address", "address is required");
  }
  const a = input as Record<string, unknown>;
  for (const field of ["name", "line1", "city", "postalCode", "country"]) {
    if (typeof a[field] !== "string" || (a[field] as string).trim() === "") {
      throw new ValidationError(field, `${field} is required`);
    }
  }
  const country = (a.country as string).toUpperCase();
  if (!COUNTRY_RE.test(country)) {
    throw new ValidationError("country", "country must be an ISO-3166 alpha-2 code");
  }
  return {
    name: (a.name as string).trim(),
    line1: (a.line1 as string).trim(),
    line2: typeof a.line2 === "string" ? a.line2.trim() : undefined,
    city: (a.city as string).trim(),
    postalCode: (a.postalCode as string).trim(),
    country,
  };
}
"""

ADDRESS_TEST_V1 = """import { validateAddress, ValidationError } from "../src/validators/address";

const valid = {
  name: "Noa Levi",
  line1: "12 Herzl St",
  city: "Tel Aviv",
  postalCode: "6100000",
  country: "il",
};

describe("validateAddress", () => {
  it("accepts a valid address and upper-cases the country", () => {
    expect(validateAddress(valid).country).toBe("IL");
  });

  it("rejects a missing city", () => {
    expect(() => validateAddress({ ...valid, city: "" })).toThrow(ValidationError);
  });

  it("rejects a bad country code", () => {
    expect(() => validateAddress({ ...valid, country: "Israel" })).toThrow(ValidationError);
  });

  it("rejects null", () => {
    expect(() => validateAddress(null)).toThrow(ValidationError);
  });
});
"""

CART_TEST_V1 = """import request from "supertest";
import { app } from "../src/server";

describe("cart routes", () => {
  it("returns an empty cart for a new customer", async () => {
    const res = await request(app).get("/api/cart").set("x-customer-id", "cus_test_1");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("adds an item", async () => {
    const res = await request(app)
      .post("/api/cart/items")
      .set("x-customer-id", "cus_test_2")
      .send({ sku: "TSHIRT-BLK-M", qty: 2, unitPrice: 79.9 });
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(1);
  });

  it("rejects an item without sku", async () => {
    const res = await request(app).post("/api/cart/items").send({ qty: 1 });
    expect(res.status).toBe(400);
  });
});
"""

DOCKERFILE_V1 = """FROM node:20-bullseye AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bullseye-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
"""

DEPLOYMENT_V1 = """apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout
  namespace: shop
  labels:
    app: checkout
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  selector:
    matchLabels:
      app: checkout
  template:
    metadata:
      labels:
        app: checkout
    spec:
      containers:
        - name: checkout
          image: registry.shipfast.example/checkout:latest
          ports:
            - containerPort: 8080
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: checkout-db
                  key: url
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 1
            failureThreshold: 5
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            periodSeconds: 5
"""

SERVICE_YAML = """apiVersion: v1
kind: Service
metadata:
  name: checkout
  namespace: shop
spec:
  selector:
    app: checkout
  ports:
    - port: 80
      targetPort: 8080
"""

CI_V1 = """name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run lint
      - run: npm test -- --ci
"""

GIFT_MESSAGE_TS = """import { ValidationError } from "./address";

// only allow words and single spaces — keeps the label printer happy
const GIFT_MESSAGE_RE = /^(\\w+\\s?)*$/;

export const GIFT_MESSAGE_MAX_LEN = 200;

/**
 * Sanitizes a gift message before it is stored on the order and printed on the packing slip.
 * The warehouse label printer chokes on emoji and odd punctuation, so we reject those up front.
 */
export function sanitizeGiftMessage(msg: string): string {
  if (msg.length > GIFT_MESSAGE_MAX_LEN) {
    throw new ValidationError("giftMessage", `gift message must be at most ${GIFT_MESSAGE_MAX_LEN} characters`);
  }
  if (!GIFT_MESSAGE_RE.test(msg)) {
    throw new ValidationError("giftMessage", "gift message may only contain letters, numbers and spaces");
  }
  return msg.trim();
}
"""

GIFT_MESSAGE_TEST = """import { sanitizeGiftMessage } from "../src/validators/giftMessage";
import { ValidationError } from "../src/validators/address";

describe("sanitizeGiftMessage", () => {
  it("accepts a simple message", () => {
    expect(sanitizeGiftMessage("Happy birthday")).toBe("Happy birthday");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeGiftMessage("Happy birthday ")).toBe("Happy birthday");
  });

  it("rejects punctuation the printer can't handle", () => {
    expect(() => sanitizeGiftMessage("Hi mom!")).toThrow(ValidationError);
  });
});
"""

CHECKOUT_TEST = """import request from "supertest";
import { app } from "../src/server";

jest.mock("../src/lib/db", () => ({
  query: jest.fn().mockResolvedValue({ rows: [{ id: "ORD-TEST01" }] }),
}));

const address = {
  name: "Dana K",
  line1: "1 Rothschild Blvd",
  city: "Tel Aviv",
  postalCode: "6688101",
  country: "IL",
};

describe("POST /api/checkout", () => {
  it("rejects an empty cart", async () => {
    const res = await request(app)
      .post("/api/checkout")
      .set("x-customer-id", "cus_empty")
      .send({ address });
    expect(res.status).toBe(400);
  });

  it("places an order", async () => {
    await request(app)
      .post("/api/cart/items")
      .set("x-customer-id", "cus_buyer")
      .send({ sku: "MUG-WHT", qty: 1, unitPrice: 39 });
    const res = await request(app)
      .post("/api/checkout")
      .set("x-customer-id", "cus_buyer")
      .send({ address });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("paid");
  });

  it("returns 422 for an invalid address", async () => {
    await request(app)
      .post("/api/cart/items")
      .set("x-customer-id", "cus_badaddr")
      .send({ sku: "MUG-WHT", qty: 1, unitPrice: 39 });
    const res = await request(app)
      .post("/api/checkout")
      .set("x-customer-id", "cus_badaddr")
      .send({ address: { ...address, country: "Israel" } });
    expect(res.status).toBe(422);
  });
});
"""


# --------------------------------------------------------------------------------------------
# Repo state + commit plan
# --------------------------------------------------------------------------------------------


@dataclass
class RepoState:
    files: dict[str, str] = field(default_factory=dict)
    pkg: dict[str, object] = field(default_factory=dict)

    def put(self, path: str, content: str) -> None:
        self.files[path] = content

    def sub(self, path: str, old: str, new: str) -> None:
        content = self.files[path]
        if content.count(old) != 1:
            raise RuntimeError(f"sub target not unique/found in {path}: {old!r}")
        self.files[path] = content.replace(old, new)

    def append(self, path: str, text: str) -> None:
        self.files[path] = self.files[path] + text

    def dep(self, name: str, version: str, dev: bool = False) -> None:
        key = "devDependencies" if dev else "dependencies"
        deps = self.pkg[key]
        assert isinstance(deps, dict)
        deps[name] = version
        self.pkg[key] = dict(sorted(deps.items()))

    def script(self, name: str, cmd: str) -> None:
        scripts = self.pkg["scripts"]
        assert isinstance(scripts, dict)
        scripts[name] = cmd

    def render(self) -> dict[str, str]:
        out = dict(self.files)
        out["package.json"] = json.dumps(self.pkg, indent=2) + "\n"
        return out


Mutation = Callable[[RepoState], None]


@dataclass(frozen=True)
class Commit:
    author: str
    when: datetime  # Israel local wall time
    message: str
    change: Mutation
    tag: str | None = None


def set_version(version: str) -> Mutation:
    def apply(s: RepoState) -> None:
        s.pkg["version"] = version

    return apply


def chain(*fns: Mutation) -> Mutation:
    def apply(s: RepoState) -> None:
        for fn in fns:
            fn(s)

    return apply


def c_initial(s: RepoState) -> None:
    s.pkg = {
        "name": "shipfast-checkout",
        "version": "2.11.4",
        "private": True,
        "description": "Cart and checkout API for the Shipfast storefront",
        "main": "dist/server.js",
        "scripts": {
            "build": "tsc -p tsconfig.json",
            "start": "node dist/server.js",
            "dev": "ts-node-dev --respawn src/server.ts",
        },
        "engines": {"node": ">=20"},
        "dependencies": {"express": "^4.19.2", "pino": "^8.19.0"},
        "devDependencies": {
            "@types/express": "^4.17.21",
            "@types/node": "^20.12.7",
            "ts-node-dev": "^2.0.0",
            "typescript": "^5.4.5",
        },
    }
    s.put(".gitignore", GITIGNORE)
    s.put("tsconfig.json", TSCONFIG)
    s.put("README.md", README_V1)
    s.put(".env.example", ENV_EXAMPLE)
    s.put("src/lib/logger.ts", LOGGER_V1)
    s.put("src/server.ts", SERVER_V1)


def c_cart(s: RepoState) -> None:
    s.put("src/routes/cart.ts", CART_V1)
    s.sub("src/server.ts", 'import { logger } from "./lib/logger";\n',
          'import { logger } from "./lib/logger";\nimport { cartRouter } from "./routes/cart";\n')
    s.sub("src/server.ts", 'app.use(express.json({ limit: "100kb" }));\n',
          'app.use(express.json({ limit: "100kb" }));\n\napp.use("/api/cart", cartRouter);\n')


def c_db(s: RepoState) -> None:
    s.put("src/lib/db.ts", DB_V1)
    s.dep("pg", "^8.11.5")
    s.dep("@types/pg", "^8.11.5", dev=True)


def c_checkout(s: RepoState) -> None:
    s.put("src/routes/checkout.ts", CHECKOUT_V1)
    s.sub("src/server.ts", 'import { cartRouter } from "./routes/cart";\n',
          'import { cartRouter } from "./routes/cart";\nimport { checkoutRouter } from "./routes/checkout";\n')
    s.sub("src/server.ts", 'app.use("/api/cart", cartRouter);\n',
          'app.use("/api/cart", cartRouter);\napp.use("/api/checkout", checkoutRouter);\n')


def c_jest(s: RepoState) -> None:
    s.put("jest.config.js", JEST_CONFIG)
    s.put("test/cart.test.ts", CART_TEST_V1)
    s.script("test", "jest")
    s.dep("jest", "^29.7.0", dev=True)
    s.dep("ts-jest", "^29.1.2", dev=True)
    s.dep("@types/jest", "^29.5.12", dev=True)
    s.dep("supertest", "^7.0.0", dev=True)
    s.dep("@types/supertest", "^6.0.2", dev=True)
    # export app for supertest, only listen when run directly
    s.sub("src/server.ts", "const app = express();\n", "export const app = express();\n")
    s.sub("src/server.ts",
          "app.listen(port, () => {\n  logger.info({ port }, \"server.start\");\n});\n",
          "if (require.main === module) {\n  app.listen(port, () => {\n"
          "    logger.info({ port }, \"server.start\");\n  });\n}\n")


def c_docker(s: RepoState) -> None:
    s.put("Dockerfile", DOCKERFILE_V1)
    s.put(".dockerignore", DOCKERIGNORE)


def c_k8s(s: RepoState) -> None:
    s.put("k8s/deployment.yaml", DEPLOYMENT_V1)
    s.put("k8s/service.yaml", SERVICE_YAML)


def c_address(s: RepoState) -> None:
    s.put("src/validators/address.ts", ADDRESS_V1)
    s.sub("src/routes/checkout.ts", 'import { getCart } from "./cart";\n',
          'import { getCart } from "./cart";\nimport { validateAddress } from "../validators/address";\n')
    s.sub("src/routes/checkout.ts",
          "  const total = items.reduce(",
          "  const address = validateAddress(req.body?.address);\n  const total = items.reduce(")
    s.sub("src/routes/checkout.ts",
          '  res.status(201).json({ status: "paid", total });\n',
          '  res.status(201).json({ status: "paid", total, shipTo: address.city });\n')


def c_address_tests(s: RepoState) -> None:
    s.put("test/address.test.ts", ADDRESS_TEST_V1)


def c_healthz(s: RepoState) -> None:
    s.sub("src/server.ts", 'app.use("/api/cart", cartRouter);\n',
          'app.get("/healthz", (_req, res) => {\n  res.status(200).send("ok");\n});\n\n'
          'app.use("/api/cart", cartRouter);\n')


def c_negative_qty(s: RepoState) -> None:
    s.sub("src/routes/cart.ts",
          '  if (typeof sku !== "string" || typeof qty !== "number") {\n'
          '    return res.status(400).json({ error: "sku and qty are required" });\n  }\n',
          '  if (typeof sku !== "string" || typeof qty !== "number") {\n'
          '    return res.status(400).json({ error: "sku and qty are required" });\n  }\n'
          '  if (!Number.isInteger(qty) || qty <= 0) {\n'
          '    return res.status(400).json({ error: "qty must be a positive integer" });\n  }\n')


def c_readme_dev(s: RepoState) -> None:
    s.append("README.md", README_DEV_SECTION)


def c_ci(s: RepoState) -> None:
    s.put(".github/workflows/ci.yml", CI_V1)
    s.script("lint", "tsc --noEmit")


def c_422(s: RepoState) -> None:
    s.sub("src/routes/checkout.ts",
          'import { validateAddress } from "../validators/address";\n',
          'import { validateAddress, ValidationError } from "../validators/address";\n')
    s.sub("src/routes/checkout.ts",
          "  const address = validateAddress(req.body?.address);\n",
          "  let address;\n  try {\n    address = validateAddress(req.body?.address);\n  } catch (err) {\n"
          "    if (err instanceof ValidationError) {\n"
          "      return res.status(422).json({ error: err.message, field: err.field });\n    }\n"
          "    throw err;\n  }\n")


def c_coupons(s: RepoState) -> None:
    s.sub("src/routes/cart.ts", "const carts = new Map<string, CartItem[]>();\n",
          "const carts = new Map<string, CartItem[]>();\nconst coupons = new Map<string, string>();\n\n"
          "const COUPONS: Record<string, number> = {\n  WELCOME10: 10,\n  SHIPFAST15: 15,\n};\n")
    s.sub("src/routes/cart.ts", "export function getCart(customer: string): CartItem[] {\n",
          "export function getDiscountPct(customer: string): number {\n"
          "  const code = coupons.get(customer);\n  return code ? COUPONS[code] ?? 0 : 0;\n}\n\n"
          "export function getCart(customer: string): CartItem[] {\n")
    s.append("src/routes/cart.ts",
             "\ncartRouter.post(\"/coupon\", (req: Request, res: Response) => {\n"
             "  const code = String(req.body?.code ?? \"\").toUpperCase();\n"
             "  if (!(code in COUPONS)) {\n    return res.status(404).json({ error: \"unknown coupon\" });\n  }\n"
             "  coupons.set(customerId(req), code);\n  res.json({ code, discountPct: COUPONS[code] });\n});\n")


def c_coupon_tests(s: RepoState) -> None:
    s.sub("test/cart.test.ts", "  it(\"rejects an item without sku\"",
          "  it(\"applies a known coupon\", async () => {\n"
          "    const res = await request(app)\n      .post(\"/api/cart/coupon\")\n"
          "      .set(\"x-customer-id\", \"cus_test_3\")\n      .send({ code: \"welcome10\" });\n"
          "    expect(res.status).toBe(200);\n    expect(res.body.discountPct).toBe(10);\n  });\n\n"
          "  it(\"rejects an unknown coupon\", async () => {\n"
          "    const res = await request(app).post(\"/api/cart/coupon\").send({ code: \"FREESTUFF\" });\n"
          "    expect(res.status).toBe(404);\n  });\n\n"
          "  it(\"rejects an item without sku\"")


def c_resources(s: RepoState) -> None:
    s.sub("k8s/deployment.yaml", "          ports:\n            - containerPort: 8080\n",
          "          ports:\n            - containerPort: 8080\n"
          "          resources:\n            requests:\n              cpu: 250m\n              memory: 256Mi\n"
          "            limits:\n              cpu: \"1\"\n              memory: 512Mi\n")


def c_db_query(s: RepoState) -> None:
    s.append("src/lib/db.ts",
             "\nexport async function query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {\n"
             "  const started = Date.now();\n"
             "  const client = await pool.connect();\n"
             "  const result = await client.query(text, params);\n"
             "  client.release();\n"
             "  logger.debug({ ms: Date.now() - started, text }, \"db.query\");\n"
             "  return { rows: result.rows as T[] };\n}\n")


def c_persist_orders(s: RepoState) -> None:
    s.sub("src/routes/checkout.ts", 'import { getCart } from "./cart";\n',
          'import { getCart } from "./cart";\nimport { query } from "../lib/db";\n')
    s.sub("src/routes/checkout.ts", 'checkoutRouter.post("/", (req: Request, res: Response) => {\n',
          'checkoutRouter.post("/", async (req: Request, res: Response) => {\n')
    s.sub("src/routes/checkout.ts",
          '  res.status(201).json({ status: "paid", total, shipTo: address.city });\n',
          "  const { rows } = await query<{ id: string }>(\n"
          "    \"INSERT INTO orders (customer_id, total, ship_to) VALUES ($1, $2, $3) RETURNING id\",\n"
          "    [customer, total, JSON.stringify(address)],\n  );\n"
          '  res.status(201).json({ order: rows[0].id, status: "paid", total, shipTo: address.city });\n')


def c_typo_empty(s: RepoState) -> None:
    s.sub("src/routes/checkout.ts", '"cart is emtpy"', '"cart is empty"')


def c_ci_cache(s: RepoState) -> None:
    s.sub(".github/workflows/ci.yml", "          node-version: 20\n",
          "          node-version: 20\n          cache: npm\n")


def c_ts_bump(s: RepoState) -> None:
    s.dep("typescript", "^5.5.4", dev=True)


def c_express_bump(s: RepoState) -> None:
    s.dep("express", "^4.21.0")


def c_graceful(s: RepoState) -> None:
    s.sub("src/server.ts",
          "if (require.main === module) {\n  app.listen(port, () => {\n"
          "    logger.info({ port }, \"server.start\");\n  });\n}\n",
          "if (require.main === module) {\n  const server = app.listen(port, () => {\n"
          "    logger.info({ port }, \"server.start\");\n  });\n\n"
          "  process.on(\"SIGTERM\", () => {\n"
          "    logger.info({ signal: \"SIGTERM\" }, \"server.shutdown\");\n"
          "    server.close(() => process.exit(0));\n"
          "    setTimeout(() => process.exit(1), 10_000).unref();\n  });\n}\n")


def c_postal(s: RepoState) -> None:
    s.sub("src/validators/address.ts", "const COUNTRY_RE = /^[A-Z]{2}$/;\n",
          "const COUNTRY_RE = /^[A-Z]{2}$/;\n\nexport function normalizePostalCode(code: string): string {\n"
          "  return code.replace(/[\\s-]/g, \"\").toUpperCase();\n}\n")
    s.sub("src/validators/address.ts", "    postalCode: (a.postalCode as string).trim(),\n",
          "    postalCode: normalizePostalCode(a.postalCode as string),\n")


def c_postal_tests(s: RepoState) -> None:
    s.sub("test/address.test.ts",
          'import { validateAddress, ValidationError } from "../src/validators/address";\n',
          'import { normalizePostalCode, validateAddress, ValidationError } from "../src/validators/address";\n')
    s.append("test/address.test.ts",
             "\ndescribe(\"normalizePostalCode\", () => {\n"
             "  it(\"strips spaces and dashes\", () => {\n"
             "    expect(normalizePostalCode(\"61 000-00\")).toBe(\"6100000\");\n  });\n\n"
             "  it(\"upper-cases UK style codes\", () => {\n"
             "    expect(normalizePostalCode(\"sw1a 1aa\")).toBe(\"SW1A1AA\");\n  });\n});\n")


def c_db_release(s: RepoState) -> None:
    s.sub("src/lib/db.ts",
          "  const result = await client.query(text, params);\n  client.release();\n"
          "  logger.debug({ ms: Date.now() - started, text }, \"db.query\");\n"
          "  return { rows: result.rows as T[] };\n",
          "  try {\n    const result = await client.query(text, params);\n"
          "    logger.debug({ ms: Date.now() - started, text }, \"db.query\");\n"
          "    return { rows: result.rows as T[] };\n  } finally {\n    client.release();\n  }\n")


def c_request_id(s: RepoState) -> None:
    s.append("src/lib/logger.ts",
             "\nexport function requestLogger(rid: string) {\n  return logger.child({ rid });\n}\n")
    s.sub("src/server.ts", 'import express from "express";\n',
          'import express from "express";\nimport { randomUUID } from "crypto";\n')
    s.sub("src/server.ts", 'app.use(express.json({ limit: "100kb" }));\n',
          'app.use(express.json({ limit: "100kb" }));\napp.use((req, res, next) => {\n'
          '  const rid = req.header("x-request-id") ?? randomUUID().replace(/-/g, "");\n'
          '  res.locals.rid = rid;\n  res.setHeader("x-request-id", rid);\n  next();\n});\n')


def c_probe_tune(s: RepoState) -> None:
    s.sub("k8s/deployment.yaml",
          "            initialDelaySeconds: 10\n            periodSeconds: 10\n"
          "            timeoutSeconds: 1\n            failureThreshold: 5\n",
          "            initialDelaySeconds: 10\n            periodSeconds: 5\n"
          "            timeoutSeconds: 2\n            failureThreshold: 3\n")


def c_pg_bump(s: RepoState) -> None:
    s.dep("pg", "^8.12.0")


def c_cart_cap(s: RepoState) -> None:
    s.sub("src/routes/cart.ts", "export const cartRouter = Router();\n",
          "export const MAX_CART_ITEMS = 50;\n\nexport const cartRouter = Router();\n")
    s.sub("src/routes/cart.ts", "  const items = getCart(customerId(req));\n  items.push(",
          "  const items = getCart(customerId(req));\n  if (items.length >= MAX_CART_ITEMS) {\n"
          "    return res.status(409).json({ error: `cart is limited to ${MAX_CART_ITEMS} items` });\n  }\n"
          "  items.push(")


def c_round_totals(s: RepoState) -> None:
    s.sub("src/routes/checkout.ts",
          "  const total = items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);\n",
          "  const total = Math.round(items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0) * 100) / 100;\n")


def c_alpine(s: RepoState) -> None:
    s.sub("Dockerfile", "FROM node:20-bullseye AS build\n", "FROM node:20-alpine AS build\n")
    s.sub("Dockerfile", "FROM node:20-bullseye-slim\n", "FROM node:20-alpine\n")


def c_readme_runbook(s: RepoState) -> None:
    s.sub("README.md", "On-call rotation in PagerDuty: `checkout-primary`.\n",
          "On-call rotation in PagerDuty: `checkout-primary`.\n"
          "Runbook: https://wiki.shipfast.example/runbooks/checkout\n")


def c_pool_idle(s: RepoState) -> None:
    s.sub("src/lib/db.ts", "  idleTimeoutMillis: 30_000,\n",
          "  idleTimeoutMillis: 10_000,\n  connectionTimeoutMillis: 5_000,\n")


def c_gift_wrap(s: RepoState) -> None:
    s.sub("src/routes/checkout.ts",
          "    [customer, total, JSON.stringify(address)],\n",
          "    [customer, total, JSON.stringify(address), giftWrap],\n")
    s.sub("src/routes/checkout.ts",
          "\"INSERT INTO orders (customer_id, total, ship_to) VALUES ($1, $2, $3) RETURNING id\"",
          "\"INSERT INTO orders (customer_id, total, ship_to, gift_wrap) VALUES ($1, $2, $3, $4) RETURNING id\"")
    s.sub("src/routes/checkout.ts",
          "  const total = Math.round(",
          "  const giftWrap = req.body?.giftWrap === true;\n  const total = Math.round(")


def c_checkout_tests(s: RepoState) -> None:
    s.put("test/checkout.test.ts", CHECKOUT_TEST)


def c_ci_matrix(s: RepoState) -> None:
    s.sub(".github/workflows/ci.yml", "    runs-on: ubuntu-latest\n",
          "    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [20, 22]\n")
    s.sub(".github/workflows/ci.yml", "          node-version: 20\n",
          "          node-version: ${{ matrix.node }}\n")


def c_types_bump(s: RepoState) -> None:
    s.dep("@types/node", "^20.16.10", dev=True)
    s.dep("jest", "^29.7.0", dev=True)
    s.dep("ts-jest", "^29.2.5", dev=True)


def c_coupon_round(s: RepoState) -> None:
    s.sub("src/routes/cart.ts", "  return code ? COUPONS[code] ?? 0 : 0;\n",
          "  return code ? Math.min(100, Math.max(0, COUPONS[code] ?? 0)) : 0;\n")
    s.sub("src/routes/checkout.ts", 'import { getCart } from "./cart";\n',
          'import { getCart, getDiscountPct } from "./cart";\n')
    s.sub("src/routes/checkout.ts",
          "  const total = Math.round(items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0) * 100) / 100;\n",
          "  const subtotal = items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);\n"
          "  const total = Math.round(subtotal * (100 - getDiscountPct(customer))) / 100;\n")


def c_store_gift_message(s: RepoState) -> None:
    s.sub("src/routes/checkout.ts",
          "  const giftWrap = req.body?.giftWrap === true;\n",
          "  const giftWrap = req.body?.giftWrap === true;\n"
          "  const giftMessage =\n"
          "    typeof req.body?.giftMessage === \"string\" ? req.body.giftMessage.trim() : null;\n")
    s.sub("src/routes/checkout.ts",
          "\"INSERT INTO orders (customer_id, total, ship_to, gift_wrap) VALUES ($1, $2, $3, $4) RETURNING id\"",
          "\"INSERT INTO orders (customer_id, total, ship_to, gift_wrap, gift_message) VALUES ($1, $2, $3, $4, $5) RETURNING id\"")
    s.sub("src/routes/checkout.ts", "    [customer, total, JSON.stringify(address), giftWrap],\n",
          "    [customer, total, JSON.stringify(address), giftWrap, giftMessage],\n")


def c_anti_affinity(s: RepoState) -> None:
    s.sub("k8s/deployment.yaml", "    spec:\n      containers:\n",
          "    spec:\n      affinity:\n        podAntiAffinity:\n"
          "          preferredDuringSchedulingIgnoredDuringExecution:\n"
          "            - weight: 100\n              podAffinityTerm:\n"
          "                topologyKey: kubernetes.io/hostname\n                labelSelector:\n"
          "                  matchLabels:\n                    app: checkout\n      containers:\n")


def c_readme_typo(s: RepoState) -> None:
    s.sub("README.md", "| GET    | `/healthz`        | Liveness probe               |\n",
          "| POST   | `/api/cart/coupon`| Apply a coupon code          |\n"
          "| GET    | `/healthz`        | Liveness probe               |\n")
    s.sub("README.md", "Requires Node 20+ and a local Postgres", "Requires Node 20+ and a local PostgreSQL")


def c_express_bump2(s: RepoState) -> None:
    s.dep("express", "^4.21.1")


def c_cap_test(s: RepoState) -> None:
    s.sub("test/cart.test.ts", "  it(\"rejects an item without sku\"",
          "  it(\"refuses more than 50 line items\", async () => {\n"
          "    for (let i = 0; i < 50; i++) {\n"
          "      await request(app)\n        .post(\"/api/cart/items\")\n"
          "        .set(\"x-customer-id\", \"cus_bulk\")\n"
          "        .send({ sku: `SKU-${i}`, qty: 1, unitPrice: 1 });\n    }\n"
          "    const res = await request(app)\n      .post(\"/api/cart/items\")\n"
          "      .set(\"x-customer-id\", \"cus_bulk\")\n      .send({ sku: \"SKU-50\", qty: 1, unitPrice: 1 });\n"
          "    expect(res.status).toBe(409);\n  });\n\n"
          "  it(\"rejects an item without sku\"")


def c_logger_upgrade(s: RepoState) -> None:
    """v2.14.0 — the decoy. Harmless: pino bump + duration_ms on checkout.done."""
    s.dep("pino", "^9.5.0")
    s.pkg["version"] = "2.14.0"
    s.sub("src/lib/logger.ts", "  timestamp: pino.stdTimeFunctions.isoTime,\n",
          "  timestamp: pino.stdTimeFunctions.isoTime,\n  messageKey: \"msg\",\n"
          "  formatters: {\n    level: (label) => ({ level: label }),\n  },\n")
    s.sub("src/routes/checkout.ts", 'import { query } from "../lib/db";\n',
          'import { query } from "../lib/db";\nimport { requestLogger } from "../lib/logger";\n')
    s.sub("src/routes/checkout.ts", '  const customer = String(req.header("x-customer-id") ?? "anonymous");\n',
          '  const started = Date.now();\n  const log = requestLogger(String(res.locals.rid ?? "-"));\n'
          '  const customer = String(req.header("x-customer-id") ?? "anonymous");\n')
    s.sub("src/routes/checkout.ts",
          '  res.status(201).json({ order: rows[0].id, status: "paid", total, shipTo: address.city });\n',
          '  log.info({ order: rows[0].id, duration_ms: Date.now() - started, status: "paid" }, "checkout.done");\n'
          '  res.status(201).json({ order: rows[0].id, status: "paid", total, shipTo: address.city });\n')


def c_readme_release(s: RepoState) -> None:
    s.append("README.md", README_RELEASE_SECTION)


def c_sanitize_gift(s: RepoState) -> None:
    """v2.14.1 — the bad commit."""
    s.pkg["version"] = "2.14.1"
    s.put(BAD_FILE, GIFT_MESSAGE_TS)
    s.put("test/giftMessage.test.ts", GIFT_MESSAGE_TEST)
    s.sub("src/routes/checkout.ts",
          'import { validateAddress, ValidationError } from "../validators/address";\n',
          'import { validateAddress, ValidationError } from "../validators/address";\n'
          'import { sanitizeGiftMessage } from "../validators/giftMessage";\n')
    s.sub("src/routes/checkout.ts",
          "  const giftMessage =\n"
          "    typeof req.body?.giftMessage === \"string\" ? req.body.giftMessage.trim() : null;\n",
          "  let giftMessage: string | null = null;\n"
          "  if (typeof req.body?.giftMessage === \"string\" && req.body.giftMessage !== \"\") {\n"
          "    try {\n      giftMessage = sanitizeGiftMessage(req.body.giftMessage);\n    } catch (err) {\n"
          "      if (err instanceof ValidationError) {\n"
          "        return res.status(422).json({ error: err.message, field: err.field });\n      }\n"
          "      throw err;\n    }\n  }\n")


def D(month: int, day: int, hour: int, minute: int, second: int = 0) -> datetime:
    return datetime(2026, month, day, hour, minute, second)


PLAN: list[Commit] = [
    Commit("dana.k", D(8, 2, 10, 14, 7), "chore: import checkout service from legacy monolith", c_initial),
    Commit("dana.k", D(8, 2, 14, 31, 52), "feat(cart): add cart routes with in-memory store", c_cart),
    Commit("yossi.b", D(8, 3, 11, 5, 19), "feat(db): add postgres pool wrapper", c_db),
    Commit("yossi.b", D(8, 3, 16, 42, 3), "feat(checkout): add checkout route skeleton", c_checkout),
    Commit("maya.r", D(8, 4, 9, 51, 40), "test: add jest config and cart route tests", c_jest),
    Commit("amir.t", D(8, 4, 13, 12, 26), "chore(docker): add multi-stage Dockerfile", c_docker),
    Commit("amir.t", D(8, 5, 10, 20, 11), "chore(k8s): add deployment and service manifests", c_k8s),
    Commit("dana.k", D(8, 6, 15, 2, 45), "feat(validators): validate shipping address payload", c_address),
    Commit("maya.r", D(8, 6, 17, 33, 9), "test(validators): cover address validation edge cases", c_address_tests),
    Commit("dana.k", D(8, 9, 11, 0, 58), "feat(server): add /healthz endpoint for k8s probes", c_healthz),
    Commit("yossi.b", D(8, 10, 12, 4, 30), "chore(release): v2.12.0", set_version("2.12.0"), tag="v2.12.0"),
    Commit("yossi.b", D(8, 12, 10, 47, 15), "fix(cart): reject zero and negative item quantities", c_negative_qty),
    Commit("maya.r", D(8, 13, 14, 18, 2), "docs: document local dev setup in README", c_readme_dev),
    Commit("amir.t", D(8, 17, 9, 36, 44), "ci: add GitHub Actions workflow for lint and test", c_ci),
    Commit("dana.k", D(8, 18, 16, 9, 21), "fix(checkout): return 422 instead of 500 on invalid address", c_422),
    Commit("yossi.b", D(8, 19, 11, 27, 33), "chore(deps): bump express from 4.19.2 to 4.21.0", c_express_bump),
    Commit("dana.k", D(8, 20, 15, 55, 0), "chore(release): v2.12.1", set_version("2.12.1"), tag="v2.12.1"),
    Commit("maya.r", D(8, 24, 10, 3, 17), "feat(cart): support coupon codes", c_coupons),
    Commit("maya.r", D(8, 25, 12, 41, 8), "test(cart): add coupon tests", c_coupon_tests),
    Commit("amir.t", D(8, 27, 14, 14, 50), "chore(k8s): set cpu/memory requests and limits", c_resources),
    Commit("yossi.b", D(8, 31, 9, 58, 36), "refactor(db): add query helper with timing log", c_db_query),
    Commit("dana.k", D(9, 1, 13, 22, 4), "feat(checkout): persist orders to postgres", c_persist_orders),
    Commit("maya.r", D(9, 2, 10, 7, 12), "fix(checkout): typo in empty cart error message", c_typo_empty),
    Commit("amir.t", D(9, 3, 16, 30, 27), "ci: cache npm dependencies", c_ci_cache),
    Commit("yossi.b", D(9, 7, 11, 11, 11), "chore(deps): bump typescript from 5.4.5 to 5.5.4", c_ts_bump),
    Commit("dana.k", D(9, 8, 14, 45, 39), "chore(release): v2.13.0", set_version("2.13.0"), tag="v2.13.0"),
    Commit("amir.t", D(9, 10, 10, 26, 14), "feat(server): graceful shutdown on SIGTERM", c_graceful),
    Commit("maya.r", D(9, 14, 15, 37, 50), "feat(validators): normalize postal codes", c_postal),
    Commit("maya.r", D(9, 15, 9, 44, 2), "test(validators): add postal code normalization tests", c_postal_tests),
    Commit("yossi.b", D(9, 17, 17, 8, 29), "fix(db): always release pool client on query error", c_db_release),
    Commit("dana.k", D(9, 21, 11, 53, 6), "feat(logger): propagate request id to logs and responses", c_request_id),
    Commit("dana.k", D(9, 22, 16, 1, 45), "chore(release): v2.13.1", set_version("2.13.1"), tag="v2.13.1"),
    Commit("amir.t", D(9, 24, 10, 15, 33), "chore(k8s): tighten liveness probe so stuck pods restart faster",
           c_probe_tune),
    Commit("yossi.b", D(9, 29, 13, 2, 18), "chore(deps): bump pg from 8.11.5 to 8.12.0", c_pg_bump),
    Commit("maya.r", D(10, 1, 11, 39, 57), "feat(cart): cap cart at 50 line items", c_cart_cap),
    Commit("dana.k", D(10, 5, 14, 20, 40), "fix(checkout): round order totals to 2 decimals", c_round_totals),
    Commit("dana.k", D(10, 6, 12, 12, 12), "chore(release): v2.13.2", set_version("2.13.2"), tag="v2.13.2"),
    Commit("amir.t", D(10, 8, 9, 48, 25), "chore(docker): switch base image to node:20-alpine", c_alpine),
    Commit("maya.r", D(10, 12, 16, 6, 3), "docs: link checkout runbook in README", c_readme_runbook),
    Commit("yossi.b", D(10, 14, 10, 34, 47), "perf(db): lower pool idle timeout and add connect timeout",
           c_pool_idle),
    Commit("dana.k", D(10, 15, 15, 17, 22), "feat(checkout): accept optional giftWrap flag", c_gift_wrap),
    Commit("maya.r", D(10, 19, 11, 25, 9), "test(checkout): add checkout route tests", c_checkout_tests),
    Commit("yossi.b", D(10, 20, 14, 50, 31), "chore(release): v2.13.3", set_version("2.13.3"), tag="v2.13.3"),
    Commit("amir.t", D(10, 22, 10, 2, 54), "ci: run tests on node 20 and 22", c_ci_matrix),
    Commit("yossi.b", D(10, 27, 9, 31, 16), "chore(deps): bump @types/node and ts-jest", c_types_bump),
    Commit("maya.r", D(10, 29, 13, 44, 38), "fix(cart): apply coupon discount to checkout total", c_coupon_round),
    Commit("dana.k", D(11, 1, 16, 28, 5), "feat(checkout): store optional gift message on order", c_store_gift_message),
    Commit("amir.t", D(11, 3, 11, 9, 49), "chore(k8s): spread checkout pods across nodes", c_anti_affinity),
    Commit("dana.k", D(11, 4, 15, 36, 20), "chore(release): v2.13.4", set_version("2.13.4"), tag="v2.13.4"),
    Commit("maya.r", D(11, 8, 10, 51, 13), "docs: fix README typos and list coupon endpoint", c_readme_typo),
    Commit("yossi.b", D(11, 10, 12, 19, 44), "chore(deps): bump express from 4.21.0 to 4.21.1", c_express_bump2),
    Commit("maya.r", D(11, 11, 14, 3, 27), "test(cart): cover the 50 item cap", c_cap_test),
    Commit("dana.k", D(11, 12, 17, 20, 36), "chore: upgrade logger, add duration_ms field", c_logger_upgrade,
           tag=DECOY_TAG),
    Commit("amir.t", D(11, 12, 19, 7, 58), "docs: describe release process in README", c_readme_release),
    Commit("dana.k", D(11, 12, 23, 41, 15),
           "feat(checkout): sanitize gift messages before printing on packing slip", c_sanitize_gift,
           tag=BAD_TAG),
]


# --------------------------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------------------------


def write_tree(repo: Path, files: dict[str, str]) -> None:
    for existing in sorted(repo.rglob("*")):
        if ".git" in existing.relative_to(repo).parts:
            continue
        if existing.is_file() and existing.relative_to(repo).as_posix() not in files:
            existing.unlink()
    for rel, content in files.items():
        for word in FORBIDDEN_WORDS:
            if word in content.lower():
                raise RuntimeError(f"forbidden word {word!r} in {rel}")
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
        os.chmod(path, 0o644)


def make_commit(repo: Path, commit: Commit) -> str:
    if commit.author not in AUTHORS:
        raise ValueError(f"unknown author {commit.author}")
    for word in FORBIDDEN_WORDS:
        if word in commit.message.lower():
            raise RuntimeError(f"forbidden word in commit message: {commit.message}")
    name = T.PEOPLE[commit.author]
    email = f"{commit.author}@shipfast.example"
    date = git_date(commit.when)
    env = base_env()
    env.update(
        {
            "GIT_AUTHOR_NAME": name,
            "GIT_AUTHOR_EMAIL": email,
            "GIT_AUTHOR_DATE": date,
            "GIT_COMMITTER_NAME": name,
            "GIT_COMMITTER_EMAIL": email,
            "GIT_COMMITTER_DATE": date,
        }
    )
    git(["add", "-A"], repo, env)
    git(["commit", "-q", "--no-verify", "-m", commit.message], repo, env)
    sha = git(["rev-parse", "HEAD"], repo, env)
    if commit.tag:
        git(["tag", commit.tag], repo, env)
    return sha


def bad_line_number(content: str) -> int:
    for idx, line in enumerate(content.splitlines(), start=1):
        if line.startswith("const GIFT_MESSAGE_RE"):
            return idx
    raise RuntimeError("regex line not found")


def build_repo() -> dict[str, str]:
    if REPO_DIR.exists():
        shutil.rmtree(REPO_DIR)
    REPO_DIR.mkdir(parents=True)
    git(["init", "-q", "-b", "main"], REPO_DIR)

    dates = [c.when for c in PLAN]
    if dates != sorted(dates):
        raise RuntimeError("commit plan is not in chronological order")

    state = RepoState()
    tag_shas: dict[str, str] = {}
    for commit in PLAN:
        commit.change(state)
        write_tree(REPO_DIR, state.render())
        sha = make_commit(REPO_DIR, commit)
        if commit.tag:
            tag_shas[commit.tag] = sha
    git(["gc", "-q", "--prune=now"], REPO_DIR)
    tag_shas["__bad_line__"] = str(bad_line_number(state.files[BAD_FILE]))
    return tag_shas


def build_bundle() -> None:
    BUNDLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    if BUNDLE_PATH.exists():
        BUNDLE_PATH.unlink()
    git(["bundle", "create", "-q", str(BUNDLE_PATH), "--all"], REPO_DIR)

    # verify: clone the bundle and check tags + HEAD
    if CLONE_CHECK_DIR.exists():
        shutil.rmtree(CLONE_CHECK_DIR)
    try:
        git(["clone", "-q", str(BUNDLE_PATH), str(CLONE_CHECK_DIR)], T.BUILD)
        tags = set(git(["tag", "--list"], CLONE_CHECK_DIR).split())
        expected = {c.tag for c in PLAN if c.tag}
        if tags != expected:
            raise RuntimeError(f"bundle clone tags mismatch: {sorted(tags)} != {sorted(expected)}")
        if git(["rev-parse", "HEAD"], CLONE_CHECK_DIR) != git(["rev-parse", "HEAD"], REPO_DIR):
            raise RuntimeError("bundle clone HEAD mismatch")
    finally:
        if CLONE_CHECK_DIR.exists():
            shutil.rmtree(CLONE_CHECK_DIR)


def write_truth(tag_shas: dict[str, str]) -> dict[str, object]:
    bad = tag_shas[BAD_TAG]
    head = git(["rev-parse", "HEAD"], REPO_DIR)
    if head != bad:
        raise RuntimeError("v2.14.1 must be HEAD of main")
    truth: dict[str, object] = {
        "bad_commit_full": bad,
        "bad_commit_sha7": bad[:7],
        "bad_tag": BAD_TAG,
        "bad_function": BAD_FUNCTION,
        "bad_file": BAD_FILE,
        "bad_line": int(tag_shas["__bad_line__"]),
        "decoy_commit_sha7": tag_shas[DECOY_TAG][:7],
        "prev_commit_sha7": tag_shas[PREV_TAG][:7],
        "commit_count": len(PLAN),
    }
    TRUTH_PATH.parent.mkdir(parents=True, exist_ok=True)
    TRUTH_PATH.write_text(json.dumps(truth, indent=2) + "\n", encoding="utf-8")
    return truth


def main() -> None:
    tag_shas = build_repo()
    build_bundle()
    truth = write_truth(tag_shas)
    print(f"repo:   {REPO_DIR.relative_to(T.ROOT)} ({len(PLAN)} commits)")
    print(f"bundle: {BUNDLE_PATH.relative_to(T.ROOT)}")
    print(f"truth:  {TRUTH_PATH.relative_to(T.ROOT)}")
    for key in ("bad_commit_sha7", "decoy_commit_sha7", "prev_commit_sha7", "bad_line"):
        print(f"  {key} = {truth[key]}")


if __name__ == "__main__":
    main()
