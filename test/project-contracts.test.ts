import { describe, expect, it } from "vitest";

import { createBaselineCapabilities } from "../src/protocol/capabilities.js";
import { canonicalJson } from "../src/protocol/json.js";
import {
  candidateJobKey,
  hashProjectRegistryEntry,
  hashProjectWatchManifest,
  parseCandidateJobIntent,
  parseProjectRegistryEntry,
  parseProjectWatchManifest,
} from "../src/service/project/contracts.js";
import type {
  CandidateJobIntentV1,
  HashableProjectRegistryEntryV1,
} from "../src/service/project/types.js";
import { RuntimeProjectError } from "../src/service/project/errors.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const MANIFEST_HASH = `sha256:${"1".repeat(64)}` as const;
const ZERO_HASH = `sha256:${"0".repeat(64)}` as const;

const REGISTRY_HASHABLE: HashableProjectRegistryEntryV1 = {
  protocol_version: "runtime-contract.v1",
  schema_version: "project-registry-entry.v1",
  document_type: "project-registry-entry",
  registry_revision: 1,
  previous_entry_hash: ZERO_HASH,
  operation_id: "00000000-0000-4000-8000-000000000090",
  operation_hash: `sha256:${"9".repeat(64)}`,
  project_id: PROJECT_ID,
  canonical_root: "/tmp/toss-project",
  manifest_hash: MANIFEST_HASH,
  state: "ACTIVE",
  reason_code: "PROJECT_REGISTERED",
  timestamp: "2026-08-20T12:00:00.000Z",
};

const CANDIDATE: CandidateJobIntentV1 = {
  protocol_version: "runtime-contract.v1",
  schema_version: "candidate-job-intent.v1",
  document_type: "candidate-job-intent",
  candidate_key: "sha256:92edfb58daded371de67bef6725c61313be8d8f5738426b57de8c22539593871",
  kind: "PROJECT_CHANGED",
  project_id: PROJECT_ID,
  registry_revision: 1,
  manifest_hash: MANIFEST_HASH,
  changes: [
    {
      kind: "CHANGED",
      path: "src/index.ts",
      identity: { device: "1", inode: "2", mtime_ns: "3", size: "4" },
    },
  ],
  created_at: "2026-08-20T12:00:01.000Z",
};

describe("project intake contracts", () => {
  it("advertises every accepted project document schema in runtime capabilities", () => {
    const capabilities = createBaselineCapabilities({
      os: "darwin",
      arch: "arm64",
      node: "22.23.1",
    });

    expect(capabilities.supported_schemas).toEqual(
      expect.arrayContaining([
        "candidate-job-intent.v1",
        "project-registry-entry.v1",
        "project-watch-manifest.v1",
      ]),
    );
  });

  it("exposes only stable safe project failures", () => {
    expect(new RuntimeProjectError("RUNTIME_PROJECT_PATH_UNSAFE")).toMatchObject({
      code: "RUNTIME_PROJECT_PATH_UNSAFE",
      category: "integrity",
      retryable: false,
      safe_message: "Project path is unsafe",
    });
    expect(new RuntimeProjectError("RUNTIME_PROJECT_UNAVAILABLE")).toMatchObject({
      code: "RUNTIME_PROJECT_UNAVAILABLE",
      category: "unavailable",
      retryable: true,
      safe_message: "Project is unavailable",
    });
    expect(new RuntimeProjectError("RUNTIME_OPERATION_CONFLICT")).toMatchObject({
      code: "RUNTIME_OPERATION_CONFLICT",
      category: "stale-revision",
      retryable: false,
      safe_message: "Project operation conflicts with an existing operation",
    });
  });

  it("parses and hashes one closed project watch manifest", () => {
    const input = Buffer.from(
      [
        "schema_version: project-watch-manifest.v1",
        "watch_paths:",
        "  - src",
        "  - package.json",
        "ignore_paths:",
        "  - dist",
        "  - tmp",
        "",
      ].join("\n"),
      "utf8",
    );

    const parsed = parseProjectWatchManifest(input);

    expect(parsed).toEqual({
      ok: true,
      value: {
        schema_version: "project-watch-manifest.v1",
        watch_paths: ["src", "package.json"],
        ignore_paths: ["dist", "tmp"],
      },
    });
    if (!parsed.ok) throw new Error("manifest must parse");
    expect(hashProjectWatchManifest(parsed.value)).toBe(
      "sha256:d14261e966b542c6adbc7537012ab859e573e7f71bbab09ab0410108017b8aee",
    );
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.watch_paths)).toBe(true);
  });

  it.each([
    ["unknown field", "unknown: true\n"],
    ["duplicate YAML key", "watch_paths: [src]\nwatch_paths: [test]\n"],
    ["alias", "watch_paths: &paths [src]\nignore_paths: *paths\n"],
    ["multiple documents", "watch_paths: [src]\n---\nwatch_paths: [test]\n"],
    ["empty watch set", "watch_paths: []\n"],
    ["duplicate path", "watch_paths: [src, src]\n"],
    ["absolute path", "watch_paths: [/tmp/outside]\n"],
    ["parent segment", "watch_paths: [src/../outside]\n"],
    ["dot segment", "watch_paths: [src/./inside]\n"],
    ["empty segment", "watch_paths: [src//inside]\n"],
    ["backslash", String.raw`watch_paths: [src\inside]`],
    ["nested git metadata", "watch_paths: [src/.git]\n"],
    ["nested runtime metadata", "watch_paths: [src/.toss/runtime]\n"],
  ])("rejects a manifest with %s", (_name, body) => {
    const input = `schema_version: project-watch-manifest.v1\n${body}`;
    expect(parseProjectWatchManifest(input)).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });

  it("rejects an oversized manifest before parsing", () => {
    const input = Buffer.alloc(65_537, 0x61);
    expect(parseProjectWatchManifest(input)).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });

  it("parses an exact hash-bound registry entry", () => {
    expect(hashProjectRegistryEntry(REGISTRY_HASHABLE)).toBe(
      "sha256:1f6fe6c338ec3fa90993211aa34365926faa04a9786dc41ca430a7e7d2a6d828",
    );
    const entry = {
      ...REGISTRY_HASHABLE,
      entry_hash: "sha256:1f6fe6c338ec3fa90993211aa34365926faa04a9786dc41ca430a7e7d2a6d828",
    } as const;

    expect(parseProjectRegistryEntry(canonicalJson(entry))).toEqual({ ok: true, value: entry });
    expect(
      parseProjectRegistryEntry(canonicalJson({ ...entry, canonical_root: "/tmp/replaced" })),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
    expect(
      parseProjectRegistryEntry(canonicalJson({ ...entry, registry_revision: 2 })),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });

  it("parses a deterministic candidate key and rejects changed or unsorted changes", () => {
    expect(candidateJobKey(CANDIDATE)).toBe(CANDIDATE.candidate_key);
    expect(parseCandidateJobIntent(canonicalJson(CANDIDATE))).toEqual({
      ok: true,
      value: CANDIDATE,
    });
    expect(
      parseCandidateJobIntent(
        canonicalJson({
          ...CANDIDATE,
          changes: [{ ...CANDIDATE.changes[0], path: "src/other.ts" }],
        }),
      ),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
    expect(
      parseCandidateJobIntent(
        canonicalJson({
          ...CANDIDATE,
          changes: [
            { kind: "REMOVED", path: "z.ts", identity: null },
            { kind: "CREATED", path: "a.ts", identity: null },
          ],
        }),
      ),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });

  it.each([
    [
      "two changes for the same path",
      [
        { ...CANDIDATE.changes[0]!, kind: "CREATED" as const },
        { kind: "REMOVED" as const, path: "src/index.ts", identity: null },
      ],
    ],
    [
      "a created path without an identity",
      [{ kind: "CREATED" as const, path: "src/index.ts", identity: null }],
    ],
    ["a removed path with an identity", [{ ...CANDIDATE.changes[0]!, kind: "REMOVED" as const }]],
    ["a nested git metadata path", [{ ...CANDIDATE.changes[0]!, path: "src/.git/config" }]],
    [
      "a nested runtime metadata path",
      [{ ...CANDIDATE.changes[0]!, path: "src/.toss/runtime/state.json" }],
    ],
  ])("rejects %s even when the candidate key matches", (_name, changes) => {
    const value = { ...CANDIDATE, changes };
    const candidate = { ...value, candidate_key: candidateJobKey(value) };

    expect(parseCandidateJobIntent(canonicalJson(candidate))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });

  it.each([
    { ...CANDIDATE, kind: "RUN_REQUESTED" },
    { ...CANDIDATE, registry_revision: 0 },
    { ...CANDIDATE, extra: true },
    {
      ...CANDIDATE,
      changes: [
        {
          ...CANDIDATE.changes[0],
          identity: { ...CANDIDATE.changes[0]!.identity, inode: "-1" },
        },
      ],
    },
  ])("rejects an invalid candidate contract", (value) => {
    expect(parseCandidateJobIntent(canonicalJson(value))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });
});
