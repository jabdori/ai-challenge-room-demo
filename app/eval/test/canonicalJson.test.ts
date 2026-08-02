// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";

describe("portable canonical JSON SHA-256", () => {
  it("객체 키만 정렬하고 배열 순서를 보존한 기존 fixture SHA-256을 유지한다", () => {
    const fixture = {
      z: 1,
      a: { y: 2, x: 3 },
      list: [{ b: true, a: null }],
    };

    expect(canonicalJsonStringify(fixture)).toBe(
      '{"a":{"x":3,"y":2},"list":[{"a":null,"b":true}],"z":1}',
    );
    expect(sha256CanonicalJson(fixture)).toBe(
      "43ae9744e3047636801aabd49088329b2d20f8ebf963b8456f0a115843bdc0a7",
    );
    expect(sha256CanonicalJson({
      list: [{ a: null, b: true }],
      a: { x: 3, y: 2 },
      z: 1,
    })).toBe(
      "43ae9744e3047636801aabd49088329b2d20f8ebf963b8456f0a115843bdc0a7",
    );
  });
});
