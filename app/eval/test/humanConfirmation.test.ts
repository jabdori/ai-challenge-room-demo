// @vitest-environment node

import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHumanConfirmationReceipt,
  persistHumanConfirmationReceipt,
  type HumanConfirmationCommand,
  type HumanConfirmationExpectedContext,
  type HumanConfirmationReceipt,
} from "../review/humanConfirmation";

function fabricatedContext(): HumanConfirmationExpectedContext {
  const itemIds = [
    "H-007--X",
    "H-007--Y",
    "H-007--Z",
    "H-010--X",
    "H-010--Y",
    "H-010--Z",
    "H-011--X",
    "H-011--Y",
    "H-011--Z",
    "H-012--X",
    "H-012--Y",
    "H-012--Z",
  ];
  return {
    schema_version: "human-confirmation-expected-context-v2",
    synthetic: true,
    recorded_benchmark_pack_hash: "a".repeat(64),
    ai_pre_review_receipt_hash: "b".repeat(64),
    provisional_decision_memo_hash: "c".repeat(64),
    queue_content_hash: "d".repeat(64),
    queue_set_order_hash: "e".repeat(64),
    queue_item_ids: itemIds,
    queue_item_set_hash: "f".repeat(64),
    queue_item_order_hash: "0".repeat(64),
    proposal_items: itemIds.map((itemId) => ({
      item_id: itemId,
      expected_final_decision: "PASS",
      expected_rationale: "A fabricated proposal.",
    })),
  };
}

function fabricatedCommand(
  expected: HumanConfirmationExpectedContext,
): HumanConfirmationCommand {
  return {
    schema_version: "human-confirmation-command-v1",
    action: "ACCEPT_ALL",
    actor_label: "Challenge owner",
    expected_recorded_benchmark_pack_hash: expected.recorded_benchmark_pack_hash,
    expected_ai_pre_review_receipt_hash: expected.ai_pre_review_receipt_hash,
    expected_provisional_decision_memo_hash: expected.provisional_decision_memo_hash,
    expected_queue_content_hash: expected.queue_content_hash,
    expected_queue_set_order_hash: expected.queue_set_order_hash,
    expected_queue_item_set_hash: expected.queue_item_set_hash,
    expected_queue_item_order_hash: expected.queue_item_order_hash,
    items: expected.proposal_items.map((item, index) => ({
      item_id: item.item_id,
      final_decision: item.expected_final_decision,
      rationale: item.expected_rationale,
      proposal_resolution: "ACCEPTED",
      review_duration_ms: 1_000 + index,
      edit_duration_ms: 0,
    })),
    confirmed_at: "2026-07-17T03:10:00.000Z",
  };
}

describe("Human confirmation 권위 발급 경계", () => {
  it("fabricated plain expected context는 HUMAN_CONFIRMATION_RECEIPT를 만들 수 없다", () => {
    const fabricated = fabricatedContext();
    expect(() => buildHumanConfirmationReceipt({
      expected: fabricated,
      command: fabricatedCommand(fabricated),
    })).toThrow(/validated|authoritative|검증|artifact chain/i);
  });

  it("fabricated receipt는 persistence claim을 선점하지 못한다", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "fabricated-human-confirmation-"),
    );
    await expect(persistHumanConfirmationReceipt({
      outputDirectory,
      receipt: {
        schema_version: "human-confirmation-receipt-v1",
        artifact_kind: "HUMAN_CONFIRMATION_RECEIPT",
      } as HumanConfirmationReceipt,
    })).rejects.toThrow(/검증|build|command|receipt/i);
    expect(await readdir(outputDirectory)).toEqual([]);
  });
});
