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
import {
  isRuntimeSkillErrorCode,
  RuntimeSkillError,
  type RuntimeSkillErrorCode,
} from "./errors.js";
import {
  createSkillPrivateStoreForTest,
  type CreateSkillPrivateStoreForTestOptions,
} from "./private-store.js";
import {
  SKILL_LIMITS,
  type SkillDescriptorReference,
  type SkillExecutionEvidenceV1,
  type SkillSnapshotV1,
  type SuperpowersPhaseV1,
} from "./types.js";

interface StoredPublicSnapshotRecord {
  readonly schema_version: "skill-private-object.v1";
  readonly snapshot: SkillSnapshotV1;
}

export interface SkillEvidenceBuilder {
  evidence(runId: string): Promise<SkillExecutionEvidenceV1 | null>;
}

export interface CreateSkillEvidenceBuilderOptions extends CreateSkillPrivateStoreForTestOptions {
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

function terminalFromJournal(entry: RunJournalEntryV1 | undefined): RuntimeSkillErrorCode | null {
  if (
    entry !== undefined &&
    (entry.state === "FAILED" || entry.state === "BLOCKED") &&
    isRuntimeSkillErrorCode(entry.reason_code)
  ) {
    return entry.reason_code;
  }
  return null;
}

export function createSkillEvidenceBuilder(
  options: CreateSkillEvidenceBuilderOptions,
): SkillEvidenceBuilder {
  const store = createSkillPrivateStoreForTest(options);
  return Object.freeze({
    async evidence(runId: string): Promise<SkillExecutionEvidenceV1 | null> {
      const verified = await options.engine.evidenceHistory(runId);
      if (verified.journal === null) return null;
      const finalJournal = verified.journal.entries.at(-1);
      if (finalJournal === undefined) integrity();

      const zeroPhaseCode = terminalFromJournal(finalJournal);
      if (verified.phases.length === 0 && zeroPhaseCode === null) return null;
      if (verified.phases.length > 512) limitExceeded();

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
            request,
            decision,
            decision_journal_head: successor === undefined ? null : journalHead(successor),
          });
        });
      if (approvals.length > 128) limitExceeded();

      const phaseByPackage = new Map<`sha256:${string}`, SuperpowersPhaseV1>();
      for (const phase of verified.phases) {
        const existing = phaseByPackage.get(phase.skill.package_hash);
        if (
          existing !== undefined &&
          (existing.skill.snapshot_hash !== phase.skill.snapshot_hash ||
            !exactReference(existing.skill, phase.skill))
        ) {
          integrity();
        }
        phaseByPackage.set(phase.skill.package_hash, existing ?? phase);
      }
      if (phaseByPackage.size > 256) limitExceeded();

      const preflight = {
        protocol_version: "runtime-contract.v1" as const,
        schema_version: "skill-execution-evidence.v1" as const,
        document_type: "skill-execution-evidence" as const,
        run_id: runId,
        journal_head: verified.journal.head,
        run_state: verified.journal.state,
        snapshots: [] as readonly SkillSnapshotV1[],
        phases: verified.phases,
        approvals,
        terminal_code: verified.phases.at(-1)?.terminal_code ?? zeroPhaseCode,
      };
      let worstCaseBytes = Buffer.byteLength(canonicalJson(preflight), "utf8");
      const packageHashes = [...phaseByPackage.keys()].sort((left, right) =>
        Buffer.from(left).compare(Buffer.from(right)),
      );
      for (const packageHash of packageHashes) {
        const bytes = await store.objectBytes(packageHash);
        if (bytes === null) integrity();
        worstCaseBytes += bytes;
        if (worstCaseBytes > SKILL_LIMITS.evidenceBytes) limitExceeded();
      }

      const snapshots: SkillSnapshotV1[] = [];
      for (const packageHash of packageHashes) {
        const bytes = await store.readObject(packageHash);
        if (bytes === null) integrity();
        const phase = phaseByPackage.get(packageHash);
        if (phase === undefined) integrity();
        snapshots.push(publicSnapshot(bytes, phase).snapshot);
      }
      snapshots.sort((left, right) =>
        Buffer.from(left.document_hash).compare(Buffer.from(right.document_hash)),
      );

      const preimage = { ...preflight, snapshots };
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
