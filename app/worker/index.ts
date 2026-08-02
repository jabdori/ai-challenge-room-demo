import type { Env } from "./env";
import {
  createSitesDemoApiFromEnv,
} from "./createSitesDemoApi";

const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
});

export interface SitesWorkerOptions {
  readonly createApi: (env: Env) => SitesDemoApiHandler;
}

export type SitesDemoApiHandler = (
  request: Request,
) => Promise<Response>;

export interface SitesWorker {
  fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response>;
}

function publicError(
  code: "UNAUTHORIZED" | "INTERNAL_ERROR",
  status: number,
): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: JSON_HEADERS,
  });
}

function isApiPath(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function createSitesWorker(
  options: SitesWorkerOptions,
): SitesWorker {
  return {
    async fetch(request, env): Promise<Response> {
      if (!isApiPath(request)) {
        return env.ASSETS.fetch(request);
      }
      try {
        return await options.createApi(env)(request);
      } catch {
        return publicError("INTERNAL_ERROR", 500);
      }
    },
  };
}

const worker = createSitesWorker({
  createApi: createSitesDemoApiFromEnv,
});

export default worker;
