import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonValue,
} from "../src/protocol/json.js";

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("protocol JSON", () => {
  it("rejects duplicate keys before object construction", () => {
    expect(() => parseJsonBytes('{"run_id":"a","run_id":"b"}')).toThrow(
      /duplicate object key.*run_id/i,
    );
  });

  it("rejects comments and trailing commas instead of accepting JSONC", () => {
    expect(() => parseJsonBytes('{"ok":true,// no\n"value":1}')).toThrow(/invalid JSON/i);
    expect(() => parseJsonBytes('{"ok":true,}')).toThrow(/invalid JSON/i);
  });

  it("rejects documents beyond the byte and depth limits", () => {
    expect(() => parseJsonBytes('"four"', { maxBytes: 5, maxDepth: 64, maxMembers: 10 })).toThrow(
      /byte limit/i,
    );
    expect(() => parseJsonBytes("[[[0]]]", { maxBytes: 100, maxDepth: 2, maxMembers: 10 })).toThrow(
      /depth limit/i,
    );
  });

  it("preserves prototype-looking keys as ordinary JSON data", () => {
    const parsed = parseJsonBytes('{"__proto__":{"polluted":true}}');
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"polluted":true}}');
  });

  it("canonicalizes nested keys while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: [{ y: true, x: null }], m: -0 })).toBe(
      '{"a":[{"x":null,"y":true}],"m":0,"z":1}',
    );
  });

  it("rejects accessors without invoking them", () => {
    let invoked = false;
    const value = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        invoked = true;
        return "x";
      },
    });

    expect(() => canonicalJson(value)).toThrow(/accessor/i);
    expect(invoked).toBe(false);
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["undefined", undefined],
    ["a function", () => undefined],
    ["a class instance", new Date(0)],
    ["a sparse array", [, 1]],
  ])("rejects %s because it has no canonical JSON representation", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow();
  });

  it("rejects symbol properties instead of silently dropping them", () => {
    const marker = Symbol("marker");
    expect(() => canonicalJson({ [marker]: true })).toThrow(/symbol/i);
  });

  it("hashes hand-checked canonical UTF-8 bytes", () => {
    expect(sha256({ b: 2, a: 1 })).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    expect(sha256({ b: 2, a: 1 })).toBe(sha256({ a: 1, b: 2 }));
  });

  it("deep-freezes every parsed container", () => {
    const value = deepFreezeJson(parseJsonBytes('{"outer":{"items":[1,2]}}'));
    expect(Object.isFrozen(value)).toBe(true);
    if (isJsonObject(value)) {
      expect(Object.isFrozen(value.outer)).toBe(true);
    }
  });
});
