// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  loadRecordedSyntheticDemoProjectionFixture,
} from "../../../eval/demo/recordedSyntheticDemoProjectionFixture";
import {
  createInitialDemoState,
} from "../../hackathonDemoController";
import {
  assertPublicDemoProjection,
} from "../publicProjectionGuard";

describe("Sites 공개 projection guard", () => {
  it("정상 진행 projection을 검사한 뒤 같은 값으로 반환한다", () => {
    const progress = {
      schema_version: "sites-demo-progress-v1",
      execution_id: "exec_demo_01",
      source: "LIVE",
      status: "RUNNING",
      progress_step: "CANDIDATE_B_POLICY_SEARCH",
      current_candidate: "B",
      completed_candidate_count: 1,
      retry_count: 0,
      cleanup_status: "NOT_STARTED",
      elapsed_ms: 1_240,
    } as const;

    expect(assertPublicDemoProjection(progress)).toBe(progress);
  });

  it.each([
    "ＳＥＳＳＩＯＮ＿ＳＥＣＲＥＴ",
    "client-secret",
    "Authorization",
    "access.token",
    "private_candidate_mapping",
    "ＲＥＶＥＡＬＥＤ－ＭＡＰＰＩＮＧ",
    "label/to/candidate",
    "blind-candidate-map",
    "ＡＰＩ．ＫＥＹ",
    "Provider／Response／ID",
    "vector store id",
    "uploaded-file-id",
    "remote.resource.id",
  ])("NFKC·대소문자·구분자 변형의 공개 금지 키 %s를 거부한다", (key) => {
    expect(() => assertPublicDemoProjection({
      schema_version: "sites-demo-progress-v1",
      [key]: "redacted-test-value",
    })).toThrow(/공개|허용되지|민감/i);
  });

  it.each([
    ["API key", `prefix ＳＫ－${"Ａ".repeat(24)}`],
    ["separated API key prefix", `s_k-${"b".repeat(24)}`],
    ["project API key", `sk-proj-${"j".repeat(24)}`],
    ["service-account API key", `sk-svcacct-${"k".repeat(24)}`],
    ["provider request ID", `ＲＥＱ＿${"Ｃ".repeat(20)}`],
    ["provider response ID", `r.e.s.p-${"d".repeat(20)}`],
    ["vector store ID", `ＶＳ－${"Ｅ".repeat(20)}`],
    ["uploaded file ID", `ＦＩＬＥ＿${"f".repeat(20)}`],
    ["remote resource ID", `remote-resource-id: ${"g".repeat(20)}`],
    ["Bearer credential", `BEARER: ${"h".repeat(24)}`],
    ["client secret", `client_secret = ${"i".repeat(24)}`],
    ["private key", "-----BEGIN PRIVATE KEY-----"],
  ])("NFKC·대소문자·구분자 변형의 %s 값을 거부한다", (_label, value) => {
    expect(() => assertPublicDemoProjection({
      schema_version: "sites-demo-progress-v1",
      message: value,
    })).toThrow(/공개|원격|민감|credential/i);
  });

  it.each([
    "session_token_digest",
    "lease-token-digest",
    "DEMO_ACCESS_CODE_HASH",
    "access.code.hash",
    "network_fingerprint",
    "idempotency-key",
    "reservation_token",
    "reservation.digest",
    "reconciliation_token",
    "reconciliation-digest",
  ])("권위 상태와 재조정용 비공개 키 %s를 거부한다", (key) => {
    expect(() => assertPublicDemoProjection({
      schema_version: "sites-demo-progress-v1",
      [key]: "fake-private-value",
    })).toThrow(/공개|허용되지|민감/i);
  });

  it("블라인드 라벨과 실제 후보를 연결하는 구조적 매핑을 거부한다", () => {
    expect(() => assertPublicDemoProjection({
      schema_version: "sites-demo-progress-v1",
      entries: [{
        blind_label: "X",
        candidate_id: "A",
      }],
    })).toThrow(/공개|허용되지|민감/i);

    expect(() => assertPublicDemoProjection({
      schema_version: "sites-demo-progress-v1",
      lookup: {
        X: "A",
        Y: "B",
        Z: "C",
      },
    })).toThrow(/공개|허용되지|민감/i);
  });

  it("공개 해시와 토큰 사용량 지표는 과잉 차단하지 않는다", () => {
    const safe = {
      schema_version: "sites-demo-progress-v1",
      source_hash: "a".repeat(64),
      pack_hash: "b".repeat(64),
      review_hash: "c".repeat(64),
      token_usage: {
        input_tokens: 120,
        output_tokens: 45,
        cached_tokens: 64,
      },
    } as const;

    expect(assertPublicDemoProjection(safe)).toBe(safe);
  });

  it("정상 HackathonDemoState를 과잉 차단하지 않는다", () => {
    const state = createInitialDemoState(
      loadRecordedSyntheticDemoProjectionFixture(),
    );

    expect(assertPublicDemoProjection(state)).toBe(state);
  });
});
