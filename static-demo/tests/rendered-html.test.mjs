import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("renders the public static demo boundary", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /AI Challenge Room/);
  assert.match(html, /STATIC RECORDED DEMO/);
  assert.match(html, /No live AI calls/);
  assert.match(html, /Start with the job, not the model/);
  assert.doesNotMatch(html, /Enter judge access code/);
});

test("contains no client network or secret path", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");
  assert.doesNotMatch(page, /\bfetch\s*\(|OPENAI_API_KEY|DEMO_ACCESS_CODE|appgprj_/);
  assert.match(page, /RECORDED GPT-5\.6 AUXILIARY SIGNALS/);
  assert.match(page, /Unsupported refund completion promise detected/);
  assert.match(page, /Baseline v1 remains active/);
});
