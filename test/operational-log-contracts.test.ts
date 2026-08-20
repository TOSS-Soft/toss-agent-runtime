import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/protocol/json.js";
import { createBaselineCapabilities } from "../src/protocol/capabilities.js";
import {
  createOperationalEvent,
  parseOperationalEvent,
  sanitizeOperationalMetadata,
  sensitiveOperationalValue,
} from "../src/logging/contracts.js";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const SERVICE_ID = "00000000-0000-4000-8000-000000000002";
const CORRELATION_ID = "00000000-0000-4000-8000-000000000003";

describe("operational event contract", () => {
  it("advertises the operational event schema in runtime capabilities", () => {
    expect(
      createBaselineCapabilities({ os: "darwin", arch: "arm64", node: "22.23.1" })
        .supported_schemas,
    ).toContain("operational-event.v1");
  });

  it("creates and parses one closed canonical safe event", () => {
    const event = createOperationalEvent({
      eventId: EVENT_ID,
      timestamp: new Date("2026-08-20T12:00:00.000Z"),
      serviceInstanceId: SERVICE_ID,
      serviceSequence: 1,
      input: {
        level: "info",
        component: "supervisor",
        event: "service.ready",
        correlationId: CORRELATION_ID,
        projectId: "00000000-0000-4000-8000-000000000004",
        metadata: { pid: 42, outcome: "ready", ignored: "no" },
        allowedMetadataKeys: ["pid", "outcome"],
      },
    });

    expect(parseOperationalEvent(canonicalJson(event))).toEqual({ ok: true, value: event });
    expect(event.metadata).toEqual({ outcome: "ready", pid: 42 });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.metadata)).toBe(true);
  });

  it("omits secret-shaped, tagged, nested, non-finite, and non-allowlisted metadata", () => {
    const secret = "must-never-appear";
    const metadata = sanitizeOperationalMetadata(
      {
        status: "healthy",
        api_token: secret,
        prompt: secret,
        provider_response: secret,
        mcp_payload: secret,
        tool_output: secret,
        env: secret,
        argv: secret,
        detail: sensitiveOperationalValue(secret),
        nested: { safe: secret },
        invalid: Number.POSITIVE_INFINITY,
        ignored: secret,
      },
      [
        "status",
        "api_token",
        "prompt",
        "provider_response",
        "mcp_payload",
        "tool_output",
        "env",
        "argv",
        "detail",
        "nested",
        "invalid",
      ],
    );

    expect(metadata).toEqual({ status: "healthy" });
    expect(JSON.stringify(metadata)).not.toContain(secret);
  });

  it.each([
    ["unknown field", { extra: true }],
    ["uppercase UUID", { event_id: "018F0B7A-5F2D-7ABC-8DEF-0123456789AB" }],
    ["noncanonical timestamp", { timestamp: "2026-08-20T12:00:00Z" }],
    ["zero sequence", { service_sequence: 0 }],
    ["unsafe metadata", { metadata: { api_token: "secret" } }],
  ])("rejects %s", (_name, replacement) => {
    const event = createOperationalEvent({
      eventId: EVENT_ID,
      timestamp: new Date("2026-08-20T12:00:00.000Z"),
      serviceInstanceId: SERVICE_ID,
      serviceSequence: 1,
      input: {
        level: "info",
        component: "supervisor",
        event: "service.ready",
        correlationId: CORRELATION_ID,
      },
    });

    expect(parseOperationalEvent(canonicalJson({ ...event, ...replacement }))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });

  it("rejects an oversized event before parsing", () => {
    expect(parseOperationalEvent(Buffer.alloc(65_537, 0x61))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });
});
