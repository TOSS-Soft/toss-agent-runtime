import type { RunJournalEntryV1 } from "../journal/types.js";
import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonValue,
} from "../protocol/json.js";
import { approvalRequest, decisionMetadata, pendingMetadata } from "./approval.js";
import {
  hashSkillExecutionHandoff,
  parseSkillExecutionEvidence,
  parseSkillSnapshot,
} from "./contracts.js";
import type { SkillsEngine } from "./engine.js";
import { RuntimeSkillError } from "./errors.js";
import { createSkillPrivateStore, type CreateSkillPrivateStoreOptions } from "./private-store.js";
import {
  SKILL_LIMITS,
  type SkillDescriptorReference,
  type SkillExecutionEvidenceV1,
  type SkillSnapshotV1,
  type SuperpowersPhaseName,
  type SuperpowersPhaseV1,
} from "./types.js";

const PHASE_ORDER: readonly SuperpowersPhaseName[] = Object.freeze([
  "BRAINSTORMING",
  "TEST_DESIGN",
  "RED",
  "GREEN",
  "DEBUGGING",
  "REVIEW",
  "VERIFICATION",
]);

interface StoredPublicSnapshotRecord {
  readonly schema_version: "skill-private-object.v1";
  readonly snapshot: SkillSnapshotV1;
}

export interface SkillEvidenceBuilder {
  evidence(runId: string): Promise<SkillExecutionEvidenceV1 | null>;
}

export interface CreateSkillEvidenceBuilderOptions extends CreateSkillPrivateStoreOptions {
  readonly engine: SkillsEngine;
}

function integrity(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY");
}

function limitExceeded(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_LIMIT_EXCEEDED");
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function descriptorReference(snapshot: SkillSnapshotV1): SkillDescriptorReference {
  return Object.freeze({
    name: snapshot.descriptor.name,
    version: snapshot.descriptor.version,
    source: snapshot.descriptor.source,
    package_hash: snapshot.descriptor.package_hash,
    document_hash: snapshot.descriptor.document_hash,
  });
}

function exactReference(left: SkillDescriptorReference, right: SkillDescriptorReference): boolean {
  return (
    left.name === right.name &&
    left.version === right.version &&
    canonicalJson(left.source) === canonicalJson(right.source) &&
    left.package_hash === right.package_hash &&
    left.document_hash === right.document_hash
  );
}

function publicSnapshot(bytes: Uint8Array, phase: SuperpowersPhaseV1): StoredPublicSnapshotRecord {
  let value: JsonValue;
  try {
    value = parseJsonBytes(bytes, {
      maxBytes: SKILL_LIMITS.storedObjectBytes,
      maxDepth: SKILL_LIMITS.nestingDepth + 8,
      maxMembers: 10_000,
    });
  } catch {
    return integrity();
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schema_version", "snapshot", "skill_markdown_base64", "resources"]) ||
    value.schema_version !== "skill-private-object.v1" ||
    value.snapshot === undefined
  ) {
    return integrity();
  }
  const parsed = parseSkillSnapshot(canonicalJson(value.snapshot));
  if (
    !parsed.ok ||
    parsed.value.document_hash !== phase.skill.snapshot_hash ||
    parsed.value.package_hash !== phase.skill.package_hash ||
    !exactReference(descriptorReference(parsed.value), phase.skill)
  ) {
    return integrity();
  }
  return Object.freeze({ schema_version: "skill-private-object.v1", snapshot: parsed.value });
}

function journalHead(entry: RunJournalEntryV1) {
  return Object.freeze({
    journal_revision: entry.journal_revision,
    sequence: entry.sequence,
    entry_hash: entry.entry_hash,
  });
}

function terminalPhases(phases: readonly SuperpowersPhaseV1[]): readonly SuperpowersPhaseV1[] {
  const latest = new Map<SuperpowersPhaseName, SuperpowersPhaseV1>();
  for (const phase of phases) {
    if (phase.status !== "STARTED") latest.set(phase.phase, phase);
  }
  return Object.freeze(
    PHASE_ORDER.flatMap((phase) => {
      const record = latest.get(phase);
      return record === undefined ? [] : [record];
    }),
  );
}

export function createSkillEvidenceBuilder(
  options: CreateSkillEvidenceBuilderOptions,
): SkillEvidenceBuilder {
  const store = createSkillPrivateStore(options);
  return Object.freeze({
    async evidence(runId: string): Promise<SkillExecutionEvidenceV1 | null> {
      const verified = await options.engine.evidenceHistory(runId);
      if (verified.phases.length === 0) return null;
      if (verified.journal === null) integrity();

      const catalogHash = verified.phases.at(-1)!.catalog_hash;
      const snapshots = new Map<`sha256:${string}`, SkillSnapshotV1>();
      for (const phase of verified.phases) {
        const existing = snapshots.get(phase.skill.package_hash);
        if (existing !== undefined) {
          if (
            existing.document_hash !== phase.skill.snapshot_hash ||
            !exactReference(descriptorReference(existing), phase.skill)
          ) {
            integrity();
          }
          continue;
        }
        const bytes = await store.readObject(phase.skill.package_hash);
        if (bytes === null) integrity();
        snapshots.set(phase.skill.package_hash, publicSnapshot(bytes, phase).snapshot);
      }

      const projectedPhases = terminalPhases(verified.phases).map((phase) =>
        Object.freeze({
          phase: phase.phase,
          handler_hash: phase.handler.hash,
          phase_hash: phase.document_hash,
          input_hash: phase.input_hash,
          output_hash: phase.output_hash,
        }),
      );
      const approvals = verified.journal.entries
        .filter((entry) => {
          const metadata = entry.metadata;
          return (
            typeof metadata === "object" &&
            metadata !== null &&
            !Array.isArray(metadata) &&
            (metadata as Readonly<Record<string, JsonValue>>).kind ===
              "superpowers-approval-pending"
          );
        })
        .map((entry) => {
          const pending = pendingMetadata(entry);
          const request = approvalRequest(pending.phase, journalHead(entry));
          const successor = verified.journal!.entries.find(
            (candidate) =>
              candidate.previous_entry_hash === entry.entry_hash &&
              typeof candidate.metadata === "object" &&
              candidate.metadata !== null &&
              !Array.isArray(candidate.metadata) &&
              (candidate.metadata as Readonly<Record<string, JsonValue>>).kind ===
                "superpowers-approval-decision",
          );
          const decision =
            successor === undefined ? null : decisionMetadata(successor, entry).decision;
          return Object.freeze({
            request_hash: request.document_hash,
            decision_hash: decision?.document_hash ?? null,
            journal_head: request.pending_journal_head,
          });
        });
      const resourceHashes = [
        ...new Set(
          [...snapshots.values()].flatMap((snapshot) =>
            snapshot.resources.map((resource) => resource.hash),
          ),
        ),
      ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
      const contextHashes = [
        ...new Set(
          verified.phases
            .filter((phase) => phase.status === "STARTED")
            .map((phase) => phase.context_hash),
        ),
      ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
      const finalPhase = terminalPhases(verified.phases).at(-1) ?? verified.phases.at(-1)!;
      const skill = Object.freeze({ ...finalPhase.skill });
      const terminalCode = null;
      const preimage = {
        protocol_version: "runtime-contract.v1" as const,
        schema_version: "skill-execution-evidence.v1" as const,
        document_type: "skill-execution-evidence" as const,
        run_id: runId,
        catalog_hash: catalogHash,
        skill,
        resource_hashes: resourceHashes,
        phases: projectedPhases,
        approvals,
        context_hashes: contextHashes,
        terminal_code: terminalCode,
      };
      const withHandoff = { ...preimage, handoff_hash: hashSkillExecutionHandoff(preimage) };
      const candidate = { ...withHandoff, document_hash: sha256(withHandoff) };
      const bytes = canonicalJson(candidate);
      if (Buffer.byteLength(bytes, "utf8") > SKILL_LIMITS.evidenceBytes) limitExceeded();
      const parsed = parseSkillExecutionEvidence(bytes);
      if (!parsed.ok) integrity();
      return deepFreezeJson(
        parsed.value as unknown as JsonValue,
      ) as unknown as SkillExecutionEvidenceV1;
    },
  });
}
