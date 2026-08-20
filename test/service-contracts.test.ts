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
  data: null,
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

  it("accepts only closed command-specific project request shapes", () => {
    const operationId = "00000000-0000-4000-8000-000000000090";
    const register = {
      ...request,
      command: "project-register",
      root: "/private/tmp/project",
      operation_id: operationId,
    } as const;
    const unregister = {
      ...request,
      command: "project-unregister",
      project_id: "00000000-0000-4000-8000-000000000001",
      operation_id: operationId,
    } as const;
    const list = { ...request, command: "project-list" } as const;

    expect(parseServiceControlRequest(canonicalJson(register))).toMatchObject({ ok: true });
    expect(parseServiceControlRequest(canonicalJson(unregister))).toMatchObject({ ok: true });
    expect(parseServiceControlRequest(canonicalJson(list))).toMatchObject({ ok: true });
    const registerWithoutOperation = {
      ...request,
      command: "project-register",
      root: register.root,
    } as const;
    expect(parseServiceControlRequest(canonicalJson(registerWithoutOperation))).toMatchObject({
      ok: false,
    });
    expect(
      parseServiceControlRequest(canonicalJson({ ...list, operation_id: operationId })),
    ).toMatchObject({ ok: false });
    expect(
      parseServiceControlRequest(canonicalJson({ ...register, project_id: unregister.project_id })),
    ).toMatchObject({ ok: false });
    expect(
      parseServiceControlRequest(canonicalJson({ ...list, root: register.root })),
    ).toMatchObject({ ok: false });
    expect(
      parseServiceControlRequest(canonicalJson({ ...register, root: "relative/project" })),
    ).toMatchObject({ ok: false });
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

  it("accepts closed project registration and list response data", () => {
    const registration = {
      project_id: "00000000-0000-4000-8000-000000000001",
      registry_revision: 1,
      canonical_root: "/private/tmp/project",
      manifest_hash: `sha256:${"a".repeat(64)}`,
      state: "ACTIVE",
    } as const;
    const projectResponse = {
      schema_version: "service-control-response.v1",
      document_type: "service-control-response",
      request_id: request.request_id,
      ok: true,
      status: null,
      data: { kind: "project-registration", registration },
      error: null,
    } as const;
    const listResponse = {
      ...projectResponse,
      data: { kind: "project-list", registrations: [registration] },
    } as const;

    expect(parseServiceControlResponse(canonicalJson(projectResponse))).toMatchObject({ ok: true });
    expect(parseServiceControlResponse(canonicalJson(listResponse))).toMatchObject({ ok: true });
    expect(
      parseServiceControlResponse(canonicalJson({ ...projectResponse, status: response.status })),
    ).toMatchObject({ ok: false });
    expect(
      parseServiceControlResponse(
        canonicalJson({ ...listResponse, data: { ...listResponse.data, extra: true } }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("bounds project-list responses below the 64 KiB control frame", () => {
    const registrations = Array.from({ length: 12 }, (_, index) => ({
      project_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      registry_revision: Number.MAX_SAFE_INTEGER,
      canonical_root: `/${"a".repeat(4_095)}`,
      manifest_hash: `sha256:${"f".repeat(64)}`,
      state: "ACTIVE" as const,
    }));
    const response = {
      schema_version: "service-control-response.v1",
      document_type: "service-control-response",
      request_id: request.request_id,
      ok: true,
      status: null,
      data: { kind: "project-list", registrations },
      error: null,
    } as const;
    const bytes = Buffer.byteLength(canonicalJson(response), "utf8");

    expect(bytes).toBeLessThanOrEqual(MAX_CONTROL_MESSAGE_BYTES);
    expect(parseServiceControlResponse(canonicalJson(response))).toMatchObject({ ok: true });
    expect(
      parseServiceControlResponse(
        canonicalJson({
          ...response,
          data: {
            ...response.data,
            registrations: [
              ...registrations,
              {
                ...registrations[0]!,
                project_id: "00000000-0000-4000-8000-000000000013",
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ ok: false });
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
