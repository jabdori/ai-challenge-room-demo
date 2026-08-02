// @vitest-environment node

import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const APP_ROOT = resolve(dirname(import.meta.filename), "../..");
const WORKER_ENTRY = join(APP_ROOT, "worker/index.ts");
const LIVE_CLEANUP_RECEIPT = join(APP_ROOT, "eval/demo/liveCleanupReceipt.ts");
const LIVE_DEMO_PROJECTION = join(
  APP_ROOT,
  "eval/demo/liveSyntheticDemoProjection.ts",
);
const SITES_PLUGIN = join(APP_ROOT, "build/sites-vite-plugin.ts");
const WRANGLER_CONFIG = join(APP_ROOT, "wrangler.jsonc");

const PORTABLE_RUNTIME_FILES = [
  "eval/runtime/canonicalJson.ts",
  "eval/retrieval/policyVectorStore.ts",
  "eval/pack/evaluationPack.ts",
  "eval/cli/calibrationOutcome.ts",
] as const;

async function importTypeScriptModule(path: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(path).href);
}

function localModulePath(importer: string, specifier: string): string | null {
  const fileSpecifier = specifier.replace(/[?#].*$/u, "");
  const base = resolve(dirname(importer), fileSpecifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function collectLocalImportGraph(entry: string): Promise<{
  files: Set<string>;
  specifiers: Set<string>;
}> {
  const files = new Set<string>();
  const specifiers = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || files.has(current)) {
      continue;
    }
    files.add(current);
    const source = await readFile(current, "utf8");
    const matches = [
      ...source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/g),
      ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ];
    for (const match of matches) {
      const specifier = match[1];
      if (!specifier) {
        continue;
      }
      specifiers.add(specifier);
      if (!specifier.startsWith(".")) {
        continue;
      }
      const dependency = localModulePath(current, specifier);
      expect(dependency, `${current}의 ${specifier} import를 해석할 수 있어야 합니다.`)
        .not.toBeNull();
      if (dependency) {
        pending.push(dependency);
      }
    }
  }
  return { files, specifiers };
}

describe("Sites Worker import 경계", () => {
  it("Worker-safe cleanup builder는 CLI·Node 파일 저장 graph를 끌어오지 않는다", async () => {
    const graph = await collectLocalImportGraph(LIVE_CLEANUP_RECEIPT);

    expect([...graph.files].map((path) => path.slice(APP_ROOT.length))).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/cli\//),
      ]),
    );
    expect([...graph.specifiers].filter((specifier) =>
      /^(?:node:)?(?:fs|http|path)(?:\/.*)?$/.test(specifier)
    )).toEqual([]);
  });

  it("live projection은 recorded 전용 pack·projection graph를 끌어오지 않는다", async () => {
    const graph = await collectLocalImportGraph(LIVE_DEMO_PROJECTION);

    expect([...graph.files].map((path) => path.slice(APP_ROOT.length))).not.toEqual(
      expect.arrayContaining([
        "/eval/demo/recordedSyntheticDemo.ts",
      ]),
    );
  });

  it("Worker에서 공유할 runtime 모듈은 Node crypto와 Buffer에 의존하지 않는다", async () => {
    for (const relativePath of PORTABLE_RUNTIME_FILES) {
      const source = await readFile(join(APP_ROOT, relativePath), "utf8");
      expect(source, relativePath).not.toMatch(/from\s+["']node:crypto["']/);
      expect(source, relativePath).not.toMatch(/\bBuffer\b/);
    }
  });

  it("Worker 진입점 import graph에는 Node 서버·파일 저장 모듈이 없다", async () => {
    expect(existsSync(WORKER_ENTRY), "worker/index.ts가 있어야 합니다.").toBe(true);
    if (!existsSync(WORKER_ENTRY)) {
      return;
    }

    const graph = await collectLocalImportGraph(WORKER_ENTRY);
    expect([...graph.specifiers].filter((specifier) =>
      /^(?:node:)?(?:fs|http|path)(?:\/.*)?$/.test(specifier)
    )).toEqual([]);
    expect([...graph.files].map((path) => path.slice(APP_ROOT.length))).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /(?:Persistence|nodeWorkspaceServer|hackathonDemoProcess)/,
        ),
      ]),
    );

    const workerModule = await importTypeScriptModule(WORKER_ENTRY);
    expect(workerModule.default).toMatchObject({
      fetch: expect.any(Function),
    });
  });

  it("/api/*는 실제 환경 조립에서 fail-closed하고 나머지는 정적 assets로 전달한다", async () => {
    expect(existsSync(WORKER_ENTRY), "worker/index.ts가 있어야 합니다.").toBe(true);
    if (!existsSync(WORKER_ENTRY)) {
      return;
    }

    const workerModule = await importTypeScriptModule(WORKER_ENTRY);
    const worker = workerModule.default as {
      fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }): Promise<Response>;
    };
    const fetchAsset = vi.fn(async () => new Response("asset", { status: 200 }));
    const env = { ASSETS: { fetch: fetchAsset } };

    const apiResponse = await worker.fetch(
      new Request("https://example.test/api/health"),
      env,
    );
    expect(apiResponse.status).toBe(500);
    expect(await apiResponse.json()).toEqual({
      error: { code: "INTERNAL_ERROR" },
    });
    expect(fetchAsset).not.toHaveBeenCalled();

    const assetRequest = new Request("https://example.test/workspace");
    const assetResponse = await worker.fetch(assetRequest, env);
    expect(await assetResponse.text()).toBe("asset");
    expect(fetchAsset).toHaveBeenCalledExactlyOnceWith(assetRequest);
  });
});

describe("Sites build metadata 계약", () => {
  it("Wrangler shell은 잠긴 Worker 이름·날짜·asset route·논리 binding을 선언한다", async () => {
    expect(existsSync(WRANGLER_CONFIG), "wrangler.jsonc가 있어야 합니다.").toBe(true);
    if (!existsSync(WRANGLER_CONFIG)) {
      return;
    }

    const config = JSON.parse(await readFile(WRANGLER_CONFIG, "utf8")) as {
      name: string;
      main: string;
      compatibility_date: string;
      compatibility_flags: string[];
      assets: {
        binding: string;
        not_found_handling: string;
        run_worker_first: string[];
      };
      d1_databases: Array<{ binding: string; database_name: string; database_id: string }>;
      r2_buckets: Array<{ binding: string; bucket_name: string }>;
    };

    expect(config).toMatchObject({
      name: "server",
      main: "./worker/index.ts",
      compatibility_date: "2026-07-19",
      compatibility_flags: ["nodejs_compat"],
      assets: {
        binding: "ASSETS",
        not_found_handling: "single-page-application",
        run_worker_first: ["/api/*"],
      },
      d1_databases: [{
        binding: "DB",
        database_name: "DB",
        database_id: "DB",
      }],
      r2_buckets: [{
        binding: "ARTIFACTS",
        bucket_name: "artifacts",
      }],
    });
  });

  it("존재하는 hosting metadata와 drizzle만 dist/.openai로 복사한다", async () => {
    expect(existsSync(SITES_PLUGIN), "Sites metadata copy plugin이 있어야 합니다.").toBe(true);
    if (!existsSync(SITES_PLUGIN)) {
      return;
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), "sites-metadata-"));
    try {
      await mkdir(join(temporaryRoot, ".openai"), { recursive: true });
      await mkdir(join(temporaryRoot, "drizzle"), { recursive: true });
      await writeFile(
        join(temporaryRoot, ".openai/hosting.json"),
        '{"fixture":"hosting-metadata"}\n',
        "utf8",
      );
      await writeFile(
        join(temporaryRoot, "drizzle/0000_test.sql"),
        "SELECT 1;\n",
        "utf8",
      );

      const pluginModule = await importTypeScriptModule(SITES_PLUGIN);
      const copySitesMetadata = pluginModule.copySitesMetadata as (options: {
        root: string;
        outDir: string;
      }) => Promise<void>;
      await copySitesMetadata({
        root: temporaryRoot,
        outDir: join(temporaryRoot, "dist"),
      });

      expect(await readFile(
        join(temporaryRoot, "dist/.openai/hosting.json"),
        "utf8",
      )).toBe('{"fixture":"hosting-metadata"}\n');
      expect(await readFile(
        join(temporaryRoot, "dist/.openai/drizzle/0000_test.sql"),
        "utf8",
      )).toBe("SELECT 1;\n");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("hosting metadata와 drizzle이 아직 없으면 안전하게 아무것도 만들지 않는다", async () => {
    expect(existsSync(SITES_PLUGIN), "Sites metadata copy plugin이 있어야 합니다.").toBe(true);
    if (!existsSync(SITES_PLUGIN)) {
      return;
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), "sites-metadata-empty-"));
    try {
      const pluginModule = await importTypeScriptModule(SITES_PLUGIN);
      const copySitesMetadata = pluginModule.copySitesMetadata as (options: {
        root: string;
        outDir: string;
      }) => Promise<void>;
      await copySitesMetadata({
        root: temporaryRoot,
        outDir: join(temporaryRoot, "dist"),
      });

      expect(existsSync(join(temporaryRoot, "dist/.openai"))).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
