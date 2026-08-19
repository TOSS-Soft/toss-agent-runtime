import { describe, expect, it } from "vitest";

import {
  MAX_CONTROL_MESSAGE_BYTES,
  parseServiceControlRequest,
  parseServiceControlResponse,
  parseServiceLock,
  RuntimeServiceError,
} from "../src/index.js";
import {
  createBaselineCapabilities,
  parseRuntimeCapabilities,
} from "../src/protocol/capabilities.js";
import { canonicalJson } from "../src/protocol/json.js";

const lock = {
  schema_version: "service-lock.v1",
  document_type: "service-lock",
  service_instance_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f41",
  pid: 4217,
  executable_hash: "a".repeat(64),
  created_at: "2026-08-19T10:00:00.000Z",
} as const;

const request = {
  schema_version: "service-control-request.v1",
  document_type: "service-control-request",
  request_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f42",
  command: "status",
} as const;

const response = {
  schema_version: "service-control-response.v1",
  document_type: "service-control-response",
  request_id: request.request_id,
  ok: true,
  status: {
    package_version: "0.0.0-development",
    service_instance_id: lock.service_instance_id,
    pid: lock.pid,
    started_at: lock.created_at,
    health: "healthy",
    accepting: true,
  },
  error: null,
} as const;

describe("local service contracts", () => {
  it("accepts one closed lock document", () => {
    expect(parseServiceLock(canonicalJson(lock))).toMatchObject({ ok: true });
  });

  it("rejects unknown and sensitive request fields without reflecting values", () => {
    const result = parseServiceControlRequest(
      canonicalJson({ ...request, apiTokenValue: "must-not-persist" }),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("must-not-persist");
  });

  it("rejects input larger than the exact transport limit", () => {
    const bytes = new Uint8Array(MAX_CONTROL_MESSAGE_BYTES + 1);
    expect(parseServiceControlResponse(bytes)).toMatchObject({ ok: false });
  });

  it("reports fresh safe issues for a non-object document after another rejection", () => {
    expect(parseServiceLock(canonicalJson({ ...lock, extra: true }))).toMatchObject({ ok: false });

    const result = parseServiceLock(canonicalJson("not-a-document"));

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues).toEqual([{ path: "", keyword: "type", message: "must be object" }]);
    }
  });

  it("accepts and deep-freezes a successful status response", () => {
    const result = parseServiceControlResponse(canonicalJson(response));

    expect(result).toMatchObject({ ok: true, value: response });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.status)).toBe(true);
    }
  });

  it("rejects response branches that mix status and errors", () => {
    const result = parseServiceControlResponse(
      canonicalJson({
        ...response,
        ok: false,
        error: {
          code: "RUNTIME_SERVICE_UNAVAILABLE",
          category: "unavailable",
          retryable: true,
          safe_message: "Runtime service is unavailable",
        },
      }),
    );

    expect(result).toMatchObject({ ok: false });
  });

  it("rejects a service error whose fixed safe details were changed", () => {
    const result = parseServiceControlResponse(
      canonicalJson({
        schema_version: "service-control-response.v1",
        document_type: "service-control-response",
        request_id: request.request_id,
        ok: false,
        status: null,
        error: {
          code: "RUNTIME_SERVICE_UNAVAILABLE",
          category: "unavailable",
          retryable: true,
          safe_message: "untrusted replacement",
        },
      }),
    );

    expect(result).toMatchObject({ ok: false });
  });

  it("creates service errors with only fixed safe details", () => {
    const error = new RuntimeServiceError("RUNTIME_SERVICE_MANAGER_FAILED");

    expect(error).toMatchObject({
      code: "RUNTIME_SERVICE_MANAGER_FAILED",
      category: "unavailable",
      retryable: true,
      safe_message: "Runtime service manager failed",
    });
    expect(JSON.stringify(error)).not.toContain("stderr-or-path");
  });

  it("advertises every local service schema in a schema-valid baseline", () => {
    const capabilities = createBaselineCapabilities({
      os: "linux",
      arch: "x64",
      node: "22.23.1",
    });

    expect(capabilities.supported_schemas).toContain("service-lock.v1");
    expect(capabilities.supported_schemas).toContain("service-control-request.v1");
    expect(capabilities.supported_schemas).toContain("service-control-response.v1");
    expect(parseRuntimeCapabilities(canonicalJson(capabilities))).toMatchObject({ ok: true });
  });
});
