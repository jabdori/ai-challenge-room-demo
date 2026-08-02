// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import calibrationCase from "../data/calibration/case-c001.json";
import challenge from "../data/calibration/challenge-abc-v1.json";
import oracle from "../data/calibration/oracle-c001.json";
import orders from "../data/calibration/orders.json";
import policies from "../data/calibration/policies.json";
import {
  EXPECTED_SYNTHETIC_FIXTURE_HASHES,
  LOCKED_SYNTHETIC_CALIBRATION_DATA,
  assertLockedSyntheticCalibrationData,
  type LockedSyntheticCalibrationData,
} from "../data/syntheticCalibration";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import {
  buildCandidateInvocation,
} from "../smoke/candidateDefinitions";

describe("잠긴 합성 calibration 데이터", () => {
  it("challenge·case·ticket·policy·order·oracle에 명시적 synthetic marker가 있다", () => {
    expect(challenge.synthetic).toBe(true);
    expect(calibrationCase.synthetic).toBe(true);
    expect(calibrationCase.ticket_messages.every((message) => message.synthetic === true))
      .toBe(true);
    expect(policies.every((policy) => policy.synthetic === true)).toBe(true);
    expect(orders.every((order) => order.synthetic === true)).toBe(true);
    expect(oracle.synthetic).toBe(true);
    expect(challenge.synthetic_fixture_manifest).toEqual({
      hash_algorithm: "SHA-256_CANONICAL_JSON",
      case_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      policies_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      orders_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      oracle_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("candidate-facing DTO는 합성 marker를 명시적으로 제거해 기존 exact schema를 유지한다", () => {
    for (const candidateId of ["A", "B", "C"] as const) {
      const input = buildCandidateInvocation(candidateId).input;
      expect(input).not.toContain('"synthetic"');
    }
  });

  it("네트워크 전 preflight로 호출할 수 있는 순수 guard를 제공한다", () => {
    const connect = vi.fn();

    expect(() => {
      assertLockedSyntheticCalibrationData();
      connect();
    }).not.toThrow();
    expect(connect).toHaveBeenCalledOnce();
  });

  it("코드에 잠긴 expected hash와 challenge manifest가 정확히 일치한다", () => {
    expect(Object.isFrozen(EXPECTED_SYNTHETIC_FIXTURE_HASHES)).toBe(true);
    expect(challenge.synthetic_fixture_manifest).toEqual({
      hash_algorithm: "SHA-256_CANONICAL_JSON",
      ...EXPECTED_SYNTHETIC_FIXTURE_HASHES,
    });
  });

  it.each([
    ["challenge", (data: MutableLockedData) => { data.challenge.synthetic = false; }],
    ["case", (data: MutableLockedData) => { data.case.synthetic = false; }],
    ["ticket", (data: MutableLockedData) => { data.case.ticket_messages[0].synthetic = false; }],
    ["policy", (data: MutableLockedData) => { data.policies[0].synthetic = false; }],
    ["order", (data: MutableLockedData) => { data.orders[0].synthetic = false; }],
    ["oracle", (data: MutableLockedData) => { data.oracle.synthetic = false; }],
  ])("%s synthetic marker가 false면 preflight에서 거부한다", (_label, mutate) => {
    const data = mutableLockedData();
    mutate(data);
    expect(() => assertLockedSyntheticCalibrationData(data)).toThrow(/synthetic=true marker/);
  });

  it("synthetic marker가 누락돼도 preflight에서 거부한다", () => {
    const data = mutableLockedData();
    delete (data.case.ticket_messages[0] as { synthetic?: boolean }).synthetic;
    expect(() => assertLockedSyntheticCalibrationData(data)).toThrow(/synthetic=true marker/);
  });

  it("challenge manifest에 잠기지 않은 필드가 추가되면 exact 계약 위반으로 거부한다", () => {
    const data = mutableLockedData();
    (data.challenge.synthetic_fixture_manifest as unknown as Record<string, unknown>).forged = true;
    expect(() => assertLockedSyntheticCalibrationData(data)).toThrow(/manifest.*exact/i);
  });

  it("fixture 내용과 manifest hash를 함께 위조해도 코드에 잠긴 hash로 거부한다", () => {
    const data = mutableLockedData();
    data.policies[0].text = `${data.policies[0].text} forged`;
    data.challenge.synthetic_fixture_manifest.policies_sha256 = sha256CanonicalJson(data.policies);

    expect(data.challenge.synthetic_fixture_manifest.policies_sha256)
      .not.toBe(EXPECTED_SYNTHETIC_FIXTURE_HASHES.policies_sha256);
    expect(() => assertLockedSyntheticCalibrationData(data)).toThrow(/expected synthetic fixture hash/);
  });

  it("예상 밖 레코드와 그에 맞춘 manifest도 네트워크 호출 전에 거부한다", () => {
    const data = mutableLockedData();
    data.orders.push({
      ...structuredClone(data.orders[0]),
      order_id: "ORD-FORGED",
    });
    data.challenge.synthetic_fixture_manifest.orders_sha256 = sha256CanonicalJson(data.orders);
    const connect = vi.fn();

    expect(() => {
      assertLockedSyntheticCalibrationData(data);
      connect();
    }).toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});

type MutableLockedData = LockedSyntheticCalibrationData;

function mutableLockedData(): MutableLockedData {
  return structuredClone(LOCKED_SYNTHETIC_CALIBRATION_DATA);
}
