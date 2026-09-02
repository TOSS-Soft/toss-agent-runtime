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
import { RuntimeSkillError } from "../src/skills/errors.js";
import { RuntimeToolError } from "../src/tools/errors.js";

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

  it("accepts only the closed exact Superpowers approval request shape", () => {
    const approval = {
      ...request,
      command: "superpowers-approve",
      operation_id: "00000000-0000-4000-8000-000000000090",
      run_id: "run-1",
      expected_journal_revision: 4,
      expected_journal_head_hash: `sha256:${"a".repeat(64)}`,
      phase: "BRAINSTORMING",
      skill_name: "brainstorming",
      skill_version: "1.0.0",
      skill_snapshot_hash: `sha256:${"b".repeat(64)}`,
      approval_request_hash: `sha256:${"c".repeat(64)}`,
      decision: "APPROVE",
    } as const;

    expect(parseServiceControlRequest(canonicalJson(approval))).toMatchObject({
      ok: true,
      value: approval,
    });
    for (const mutation of [
      { ...approval, root: "/private/tmp/project" },
      { ...approval, project_id: "00000000-0000-4000-8000-000000000001" },
      { ...approval, skill_version: "01.0.0" },
      { ...approval, expected_journal_revision: 0 },
      { ...approval, expected_journal_head_hash: `sha256:${"A".repeat(64)}` },
      { ...approval, phase: "MODEL_TEXT" },
      { ...approval, decision: "YES" },
    ]) {
      expect(parseServiceControlRequest(canonicalJson(mutation))).toMatchObject({ ok: false });
    }
  });

  it("accepts only the closed exact tool approval request shape", () => {
    const approval = {
      ...request,
      command: "tool-approve",
      operation_id: "00000000-0000-4000-8000-000000000091",
      run_id: "run-1",
      expected_journal_revision: 4,
      expected_journal_head_hash: `sha256:${"a".repeat(64)}`,
      call_id: "tool-call-1",
      approval_request_hash: `sha256:${"c".repeat(64)}`,
      decision: "APPROVE",
    } as const;

    expect(parseServiceControlRequest(canonicalJson(approval))).toMatchObject({
      ok: true,
      value: approval,
    });
    for (const mutation of [
      { ...approval, phase: "BRAINSTORMING" },
      { ...approval, skill_name: "brainstorming" },
      { ...approval, call_id: "1-invalid" },
      { ...approval, expected_journal_revision: 0 },
      { ...approval, decision: "YES" },
    ]) {
      expect(parseServiceControlRequest(canonicalJson(mutation))).toMatchObject({ ok: false });
    }
  });

  it("accepts only the closed exact uncertain tool disposition request shape", () => {
    const disposition = {
      ...request,
      command: "tool-dispose",
      operation_id: "00000000-0000-4000-8000-000000000092",
      run_id: "run-1",
      expected_journal_revision: 5,
      expected_journal_head_hash: `sha256:${"a".repeat(64)}`,
      call_id: "tool-call-1",
      idempotency_key: `sha256:${"1".repeat(64)}`,
      disposition: "NO_EFFECT_CONFIRMED",
    } as const;

    expect(parseServiceControlRequest(canonicalJson(disposition))).toMatchObject({
      ok: true,
      value: disposition,
    });
    for (const mutation of [
      { ...disposition, approval_request_hash: `sha256:${"b".repeat(64)}` },
      { ...disposition, decision: "APPROVE" },
      { ...disposition, idempotency_key: `sha256:${"A".repeat(64)}` },
      { ...disposition, disposition: "RETRY" },
    ]) {
      expect(parseServiceControlRequest(canonicalJson(mutation))).toMatchObject({ ok: false });
    }
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

  it("accepts one closed approval decision response bound to the request", () => {
    const approvalResponse = {
      schema_version: "service-control-response.v1",
      document_type: "service-control-response",
      request_id: request.request_id,
      ok: true,
      status: null,
      data: {
        kind: "superpowers-approval",
        run_id: "run-1",
        state: "RUNNING",
        phase: "BRAINSTORMING",
        journal_head: {
          journal_revision: 5,
          sequence: 5,
          entry_hash: `sha256:${"d".repeat(64)}`,
        },
        approval_request_hash: `sha256:${"c".repeat(64)}`,
        approval_decision_hash: `sha256:${"e".repeat(64)}`,
        replayed: false,
      },
      error: null,
    } as const;

    expect(parseServiceControlResponse(canonicalJson(approvalResponse))).toMatchObject({
      ok: true,
      value: approvalResponse,
    });
    expect(
      parseServiceControlResponse(
        canonicalJson({
          ...approvalResponse,
          data: { ...approvalResponse.data, state: "APPROVAL_PENDING" },
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("accepts closed tool approval data and fixed tool failures", () => {
    const toolResponse = {
      schema_version: "service-control-response.v1",
      document_type: "service-control-response",
      request_id: request.request_id,
      ok: true,
      status: null,
      data: {
        kind: "tool-approval",
        run_id: "run-1",
        state: "RUNNING",
        call_id: "tool-call-1",
        journal_head: {
          journal_revision: 5,
          sequence: 5,
          entry_hash: `sha256:${"d".repeat(64)}`,
        },
        approval_request_hash: `sha256:${"c".repeat(64)}`,
        approval_decision_hash: `sha256:${"e".repeat(64)}`,
        replayed: false,
      },
      error: null,
    } as const;
    const error = new RuntimeToolError("RUNTIME_TOOL_APPROVAL_STALE");
    const failure = {
      ...toolResponse,
      ok: false,
      data: null,
      error: {
        code: error.code,
        category: error.category,
        retryable: error.retryable,
        safe_message: error.safe_message,
      },
    } as const;

    expect(parseServiceControlResponse(canonicalJson(toolResponse))).toMatchObject({ ok: true });
    expect(parseServiceControlResponse(canonicalJson(failure))).toMatchObject({ ok: true });
    expect(
      parseServiceControlResponse(
        canonicalJson({
          ...failure,
          error: { ...failure.error, safe_message: "forged detail" },
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("accepts closed uncertain tool disposition response data", () => {
    const dispositionResponse = {
      schema_version: "service-control-response.v1",
      document_type: "service-control-response",
      request_id: request.request_id,
      ok: true,
      status: null,
      data: {
        kind: "tool-disposition",
        run_id: "run-1",
        state: "RUNNING",
        call_id: "tool-call-1",
        idempotency_key: `sha256:${"1".repeat(64)}`,
        disposition: "NO_EFFECT_CONFIRMED",
        journal_head: {
          journal_revision: 6,
          sequence: 6,
          entry_hash: `sha256:${"d".repeat(64)}`,
        },
        operation_hash: `sha256:${"e".repeat(64)}`,
        replayed: false,
      },
      error: null,
    } as const;

    expect(parseServiceControlResponse(canonicalJson(dispositionResponse))).toMatchObject({
      ok: true,
      value: dispositionResponse,
    });
    expect(
      parseServiceControlResponse(
        canonicalJson({
          ...dispositionResponse,
          data: { ...dispositionResponse.data, approval_decision_hash: `sha256:${"f".repeat(64)}` },
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it.each([
    "RUNTIME_TOOL_INVALID",
    "RUNTIME_TOOL_SCHEMA_MISMATCH",
    "RUNTIME_TOOL_PROTOCOL_DOWNGRADE",
    "RUNTIME_TOOL_RESULT_INVALID",
    "RUNTIME_TOOL_POLICY_DENIED",
    "RUNTIME_TOOL_UNSUPPORTED",
    "RUNTIME_TOOL_OPERATION_CONFLICT",
    "RUNTIME_TOOL_APPROVAL_REQUIRED",
    "RUNTIME_TOOL_APPROVAL_STALE",
    "RUNTIME_TOOL_APPROVAL_REJECTED",
    "RUNTIME_TOOL_EFFECT_UNCERTAIN",
    "RUNTIME_TOOL_AUTHENTICATION",
    "RUNTIME_TOOL_UNAVAILABLE",
    "RUNTIME_TOOL_RATE_LIMIT",
    "RUNTIME_TOOL_TIMEOUT",
    "RUNTIME_TOOL_CANCELLED",
    "RUNTIME_TOOL_INTERNAL",
  ] as const)("accepts the fixed safe %s service failure", (code) => {
    const error = new RuntimeToolError(code);
    expect(
      parseServiceControlResponse(
        canonicalJson({
          schema_version: "service-control-response.v1",
          document_type: "service-control-response",
          request_id: request.request_id,
          ok: false,
          status: null,
          data: null,
          error: {
            code: error.code,
            category: error.category,
            retryable: error.retryable,
            safe_message: error.safe_message,
          },
        }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("accepts every fixed safe skill error and rejects forged details", () => {
    const error = new RuntimeSkillError("RUNTIME_SKILL_STALE_STATE");
    const failure = {
      schema_version: "service-control-response.v1",
      document_type: "service-control-response",
      request_id: request.request_id,
      ok: false,
      status: null,
      data: null,
      error: {
        code: error.code,
        category: error.category,
        retryable: error.retryable,
        safe_message: error.safe_message,
      },
    } as const;

    expect(parseServiceControlResponse(canonicalJson(failure))).toMatchObject({ ok: true });
    expect(
      parseServiceControlResponse(
        canonicalJson({ ...failure, error: { ...failure.error, retryable: true } }),
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
