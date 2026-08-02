import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  DemoArtifactNamespace,
  DemoArtifactReference,
} from "../../server/sites/demoContracts";
import {
  R2DemoArtifactStore,
} from "../../server/sites/r2DemoArtifactStore";

declare global {
  namespace Cloudflare {
    interface Env {
      ARTIFACTS: R2Bucket;
    }
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const NAMESPACES = [
  "live-evaluation-packs",
  "candidate-evidence",
  "errors",
  "cleanup-receipts",
  "recorded-fallback",
  "decision-memos",
] as const satisfies readonly DemoArtifactNamespace[];

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function hex(value: ArrayBuffer): string {
  return Array.from(
    new Uint8Array(value),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256(value: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", value));
}

async function input(
  namespace: DemoArtifactNamespace,
  canonicalJson: string,
) {
  const canonicalBytes = bytes(canonicalJson);
  return {
    namespace,
    canonicalBytes,
    sha256: await sha256(canonicalBytes),
  } as const;
}

beforeEach(async () => {
  await reset();
});

describe("R2 콘텐츠 주소 기반 artifact store", () => {
  it.each(NAMESPACES)(
    "%s namespace에 canonical JSON SHA-256 key로 새 객체를 만든다",
    async (namespace) => {
      const store = new R2DemoArtifactStore(env.ARTIFACTS);
      const artifact = await input(namespace, '{"a":1,"z":2}');

      const reference = await store.putContentAddressed(artifact);

      expect(reference).toEqual({
        namespace,
        objectKey: `${namespace}/sha256/${artifact.sha256}.json`,
        sha256: artifact.sha256,
        byteLength: artifact.canonicalBytes.byteLength,
      });
      const persisted = await env.ARTIFACTS.get(reference.objectKey);
      expect(await persisted?.text()).toBe('{"a":1,"z":2}');
      expect(hex(persisted?.checksums.sha256 ?? new ArrayBuffer(0)))
        .toBe(artifact.sha256);
    },
  );

  it("같은 canonical bytes 저장은 같은 reference 하나로 멱등 성공한다", async () => {
    const store = new R2DemoArtifactStore(env.ARTIFACTS);
    const artifact = await input(
      "live-evaluation-packs",
      '{"artifact_kind":"LIVE_DEMO_EVALUATION_PACK"}',
    );

    const first = await store.putContentAddressed(artifact);
    const beforeRetry = await env.ARTIFACTS.head(first.objectKey);
    const second = await store.putContentAddressed(artifact);
    const afterRetry = await env.ARTIFACTS.head(first.objectKey);

    expect(second).toEqual(first);
    expect(afterRetry?.version).toBe(beforeRetry?.version);
    const listed = await env.ARTIFACTS.list({
      prefix: "live-evaluation-packs/",
    });
    expect(listed.objects.map((object) => object.key)).toEqual([
      first.objectKey,
    ]);
  });

  it("호출자 hash가 bytes와 다르면 R2 write 전에 거부한다", async () => {
    const store = new R2DemoArtifactStore(env.ARTIFACTS);
    const canonicalBytes = bytes('{"safe":true}');
    const wrongHash = await sha256(bytes('{"safe":false}'));

    await expect(store.putContentAddressed({
      namespace: "errors",
      canonicalBytes,
      sha256: wrongHash,
    })).rejects.toThrow("ARTIFACT_HASH_MISMATCH");

    expect((await env.ARTIFACTS.list()).objects).toHaveLength(0);
  });

  it("정렬되지 않았거나 JSON이 아닌 bytes를 canonical artifact로 저장하지 않는다", async () => {
    const store = new R2DemoArtifactStore(env.ARTIFACTS);
    const unsorted = bytes('{"z":2,"a":1}');
    const invalidJson = bytes("not-json");

    await expect(store.putContentAddressed({
      namespace: "candidate-evidence",
      canonicalBytes: unsorted,
      sha256: await sha256(unsorted),
    })).rejects.toThrow("ARTIFACT_NOT_CANONICAL_JSON");
    await expect(store.putContentAddressed({
      namespace: "candidate-evidence",
      canonicalBytes: invalidJson,
      sha256: await sha256(invalidJson),
    })).rejects.toThrow("ARTIFACT_NOT_CANONICAL_JSON");
    expect((await env.ARTIFACTS.list()).objects).toHaveLength(0);
  });

  it("create-only 조건 실패 시 기존 bytes가 다르면 덮어쓰지 않고 충돌로 거부한다", async () => {
    const store = new R2DemoArtifactStore(env.ARTIFACTS);
    const artifact = await input("errors", '{"error_code":"EXPECTED"}');
    const conflictingBytes = bytes('{"error_code":"PREEXISTING"}');
    const objectKey = `errors/sha256/${artifact.sha256}.json`;
    await env.ARTIFACTS.put(objectKey, conflictingBytes);

    await expect(store.putContentAddressed(artifact))
      .rejects.toThrow("ARTIFACT_CONTENT_CONFLICT");

    const persisted = await env.ARTIFACTS.get(objectKey);
    expect(await persisted?.text()).toBe(decoder.decode(conflictingBytes));
  });

  it("읽을 때 reference key·hash·길이와 저장 bytes·canonical JSON을 재검산한다", async () => {
    const store = new R2DemoArtifactStore(env.ARTIFACTS);
    const artifact = await input("decision-memos", '{"memo":"approved"}');
    const reference = await store.putContentAddressed(artifact);

    await expect(store.getVerified({
      ...reference,
      objectKey: `errors/sha256/${reference.sha256}.json`,
    })).rejects.toThrow("ARTIFACT_REFERENCE_INVALID");
    await expect(store.getVerified({
      ...reference,
      byteLength: reference.byteLength + 1,
    })).rejects.toThrow("ARTIFACT_LENGTH_MISMATCH");

    await env.ARTIFACTS.put(reference.objectKey, bytes('{"memo":"tampered"}'));
    await expect(store.getVerified(reference))
      .rejects.toThrow("ARTIFACT_HASH_MISMATCH");
  });

  it("읽은 canonical bytes를 검증 후 새 Uint8Array로 반환한다", async () => {
    const store = new R2DemoArtifactStore(env.ARTIFACTS);
    const artifact = await input("recorded-fallback", '{"source":"RECORDED"}');
    const reference = await store.putContentAddressed(artifact);

    const loaded = await store.getVerified(reference);

    expect(decoder.decode(loaded)).toBe('{"source":"RECORDED"}');
    expect(loaded).not.toBe(artifact.canonicalBytes);
  });

  it("key와 hash가 맞아도 저장 bytes가 canonical JSON이 아니면 읽기를 거부한다", async () => {
    const store = new R2DemoArtifactStore(env.ARTIFACTS);
    const noncanonicalBytes = bytes('{"z":2,"a":1}');
    const digest = await sha256(noncanonicalBytes);
    const reference: DemoArtifactReference = {
      namespace: "candidate-evidence",
      objectKey: `candidate-evidence/sha256/${digest}.json`,
      sha256: digest,
      byteLength: noncanonicalBytes.byteLength,
    };
    await env.ARTIFACTS.put(reference.objectKey, noncanonicalBytes, {
      sha256: new Uint8Array(
        await crypto.subtle.digest("SHA-256", noncanonicalBytes),
      ),
    });

    await expect(store.getVerified(reference))
      .rejects.toThrow("ARTIFACT_NOT_CANONICAL_JSON");
  });

  it("cleanup receipt는 평가팩과 분리하고 공개 reference에 private evidence를 넣지 않는다", async () => {
    const store = new R2DemoArtifactStore(env.ARTIFACTS);
    const privateJson = [
      '{"deletion_acknowledgement":{"deleted":true},',
      '"provider_resource_id":"vs_private_remote"}',
    ].join("");
    const cleanup = await input("cleanup-receipts", privateJson);
    const evaluation = await input("live-evaluation-packs", '{"result":"PASS"}');

    const cleanupReference = await store.putContentAddressed(cleanup);
    const evaluationReference = await store.putContentAddressed(evaluation);

    expect(cleanupReference.objectKey).not.toBe(evaluationReference.objectKey);
    expect(cleanupReference.objectKey).toMatch(/^cleanup-receipts\/sha256\//);
    expect(evaluationReference.objectKey)
      .toMatch(/^live-evaluation-packs\/sha256\//);
    const publicReference = JSON.stringify(
      cleanupReference satisfies DemoArtifactReference,
    );
    expect(publicReference).not.toContain("vs_private_remote");
    expect(publicReference).not.toContain("deleted");
    expect(decoder.decode(await store.getVerified(cleanupReference)))
      .toContain("vs_private_remote");
  });
});
