import calibrationCaseFixture from "./calibration/case-c001.json";
import challengeFixture from "./calibration/challenge-abc-v1.json";
import oracleFixture from "./calibration/oracle-c001.json";
import ordersFixture from "./calibration/orders.json";
import policiesFixture from "./calibration/policies.json";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

export interface LockedSyntheticCalibrationData {
  challenge: typeof challengeFixture;
  case: typeof calibrationCaseFixture;
  policies: typeof policiesFixture;
  orders: typeof ordersFixture;
  oracle: typeof oracleFixture;
}

const EXPECTED_IDENTIFIERS = Object.freeze({
  challengeId: "customer-support-policy-calibration",
  challengeVersion: "challenge-abc-v1",
  caseId: "C-001",
  orderId: "ORD-1042",
  customerId: "CUS-0101",
  policySourceIds: ["CANCEL-2026", "CANCEL-2025"],
});

export const EXPECTED_SYNTHETIC_FIXTURE_HASHES = Object.freeze({
  case_sha256: "b09ef8783f0a03f62ae315dec6eeab9c5ce0fc9c732c97b406d2f78c1f6bd1bf",
  policies_sha256: "66b60fb389b72f3692fca967cc9b908459726155e20193db423d16cf6831fbda",
  orders_sha256: "8ac7cb72942789a0ff3972f0a511824bafab3d40070168853137063a83b94a60",
  oracle_sha256: "39c2bec34545478f88f3ac043e409a3849e353633856bedf741b0c5753e80e3e",
});

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const LOCKED_SYNTHETIC_CALIBRATION_DATA: LockedSyntheticCalibrationData = Object.freeze({
  challenge: snapshot(challengeFixture),
  case: snapshot(calibrationCaseFixture),
  policies: snapshot(policiesFixture),
  orders: snapshot(ordersFixture),
  oracle: snapshot(oracleFixture),
});

function requireSyntheticMarker(value: { synthetic?: boolean }, label: string): void {
  if (value.synthetic !== true) {
    throw new Error(`${label}에는 synthetic=true marker가 필요합니다.`);
  }
}

function assertExactOrderedStrings(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (
    actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`${label}가 잠긴 synthetic calibration 식별자와 일치하지 않습니다.`);
  }
}

export function assertLockedSyntheticCalibrationData(
  source: LockedSyntheticCalibrationData = LOCKED_SYNTHETIC_CALIBRATION_DATA,
): void {
  const data = snapshot(source);
  requireSyntheticMarker(data.challenge, "challenge");
  requireSyntheticMarker(data.case, "case");
  data.case.ticket_messages.forEach((message, index) => {
    requireSyntheticMarker(message, `case.ticket_messages[${index}]`);
  });
  data.policies.forEach((policy, index) => {
    requireSyntheticMarker(policy, `policies[${index}]`);
  });
  data.orders.forEach((order, index) => {
    requireSyntheticMarker(order, `orders[${index}]`);
  });
  requireSyntheticMarker(data.oracle, "oracle");

  if (
    data.challenge.challenge_id !== EXPECTED_IDENTIFIERS.challengeId
    || data.challenge.challenge_version !== EXPECTED_IDENTIFIERS.challengeVersion
    || data.case.case_id !== EXPECTED_IDENTIFIERS.caseId
    || data.case.order_id !== EXPECTED_IDENTIFIERS.orderId
    || data.case.authenticated_customer_id !== EXPECTED_IDENTIFIERS.customerId
    || data.oracle.case_id !== EXPECTED_IDENTIFIERS.caseId
  ) {
    throw new Error("challenge/case/order/customer/oracle ID가 잠긴 synthetic calibration과 다릅니다.");
  }
  assertExactOrderedStrings(
    data.challenge.case_ids,
    [EXPECTED_IDENTIFIERS.caseId],
    "challenge.case_ids",
  );
  assertExactOrderedStrings(
    data.challenge.policy_source_ids,
    EXPECTED_IDENTIFIERS.policySourceIds,
    "challenge.policy_source_ids",
  );
  assertExactOrderedStrings(
    data.policies.map((policy) => policy.source_id),
    EXPECTED_IDENTIFIERS.policySourceIds,
    "policy source IDs",
  );
  if (
    data.orders.length !== 1
    || data.orders[0].order_id !== EXPECTED_IDENTIFIERS.orderId
    || data.orders[0].customer_id !== EXPECTED_IDENTIFIERS.customerId
  ) {
    throw new Error("주문 레코드가 잠긴 synthetic calibration 범위와 다릅니다.");
  }

  const manifest = data.challenge.synthetic_fixture_manifest;
  const manifestKeys = Object.keys(manifest).sort();
  const expectedManifestKeys = [
    "hash_algorithm",
    ...Object.keys(EXPECTED_SYNTHETIC_FIXTURE_HASHES),
  ].sort();
  if (
    manifestKeys.length !== expectedManifestKeys.length
    || manifestKeys.some((key, index) => key !== expectedManifestKeys[index])
  ) {
    throw new Error("synthetic fixture manifest가 잠긴 exact 필드 계약과 다릅니다.");
  }
  if (manifest.hash_algorithm !== "SHA-256_CANONICAL_JSON") {
    throw new Error("synthetic fixture manifest hash algorithm이 잠긴 계약과 다릅니다.");
  }
  const manifestHashes = {
    case_sha256: manifest.case_sha256,
    policies_sha256: manifest.policies_sha256,
    orders_sha256: manifest.orders_sha256,
    oracle_sha256: manifest.oracle_sha256,
  };
  for (const [field, expectedHash] of Object.entries(EXPECTED_SYNTHETIC_FIXTURE_HASHES)) {
    if (manifestHashes[field as keyof typeof manifestHashes] !== expectedHash) {
      throw new Error(`synthetic fixture manifest가 expected synthetic fixture hash와 다릅니다: ${field}`);
    }
  }
  const actualHashes = {
    case_sha256: sha256CanonicalJson(data.case),
    policies_sha256: sha256CanonicalJson(data.policies),
    orders_sha256: sha256CanonicalJson(data.orders),
    oracle_sha256: sha256CanonicalJson(data.oracle),
  };
  for (const [field, actualHash] of Object.entries(actualHashes)) {
    if (EXPECTED_SYNTHETIC_FIXTURE_HASHES[field as keyof typeof actualHashes] !== actualHash) {
      throw new Error(`expected synthetic fixture hash mismatch: ${field}`);
    }
  }
}

export function buildCandidateFacingCase(
  source = LOCKED_SYNTHETIC_CALIBRATION_DATA.case,
) {
  return {
    case_id: source.case_id,
    dataset_split: source.dataset_split,
    case_family: source.case_family,
    as_of: source.as_of,
    locale: source.locale,
    authenticated_customer_id: source.authenticated_customer_id,
    order_id: source.order_id,
    order_context_authorized: source.order_context_authorized,
    ticket_messages: source.ticket_messages.map(({ role, content }) => ({ role, content })),
  };
}

export function buildCandidateFacingPolicies(
  source = LOCKED_SYNTHETIC_CALIBRATION_DATA.policies,
) {
  return source.map((policy) => ({
    source_id: policy.source_id,
    section_id: policy.section_id,
    fact_id: policy.fact_id,
    title: policy.title,
    lifecycle_status: policy.lifecycle_status,
    effective_from: policy.effective_from,
    effective_to: policy.effective_to,
    text: policy.text,
    supported_action_codes: [...policy.supported_action_codes],
    forbidden_action_codes: [...policy.forbidden_action_codes],
  }));
}

export function buildCandidateFacingOrder(source: typeof ordersFixture[number]) {
  return {
    order_id: source.order_id,
    customer_id: source.customer_id,
    status: source.status,
    fulfillment_locked: source.fulfillment_locked,
    placed_at: source.placed_at,
    shipped_at: source.shipped_at,
    delivered_at: source.delivered_at,
    promised_delivery_date: source.promised_delivery_date,
    total_amount: source.total_amount,
    currency: source.currency,
  };
}
