import type { RunJournalEntryV1 } from "../journal/types.js";
import { canonicalJson, deepFreezeJson, parseJsonBytes, type JsonValue } from "../protocol/json.js";
import { approvalRequest, decisionMetadata, pendingMetadata } from "./approval.js";
import {
  canonicalSkillEvidenceJson,
  hashSkillCatalog,
  hashSkillExecutionEvidence,
  hashSkillExecutionHandoff,
  parseSkillDescriptor,
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
  type SkillCatalogRoot,
  type SkillDescriptorReference,
  type SkillExecutionEvidenceV1,
  type SkillJournalPathLinkV1,
  type SkillSnapshotV1,
  type SuperpowersPhaseV1,
} from "./types.js";

interface StoredPublicSnapshotRecord {
  readonly schema_version: "skill-private-object.v1";
  readonly snapshot: SkillSnapshotV1;
}

interface StoredCatalogRootRecord {
  readonly schema_version: "skill-private-catalog-root.v1";
  readonly catalog_root: SkillCatalogRoot;
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

function evidenceJson(value: unknown): string {
  try {
    return canonicalSkillEvidenceJson(value);
  } catch {
    return limitExceeded();
  }
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is { readonly [key: string]: JsonValue } {
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

function descriptorOrder(
  left: SkillCatalogRoot["descriptors"][number],
  right: SkillCatalogRoot["descriptors"][number],
): number {
  for (const [leftField, rightField] of [
    [left.name, right.name],
    [left.version, right.version],
    [left.source.kind, right.source.kind],
    [left.source.identity, right.source.identity],
    [left.package_hash, right.package_hash],
    [left.document_hash, right.document_hash],
  ] as const) {
    const order = Buffer.from(leftField, "utf8").compare(Buffer.from(rightField, "utf8"));
    if (order !== 0) return order;
  }
  return 0;
}

function publicCatalogRoot(
  bytes: Uint8Array,
  expectedHash: `sha256:${string}`,
): StoredCatalogRootRecord {
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
    !exactKeys(value, ["schema_version", "catalog_root"]) ||
    value.schema_version !== "skill-private-catalog-root.v1" ||
    !isRecord(value.catalog_root) ||
    !exactKeys(value.catalog_root, ["descriptors", "catalog_hash"]) ||
    !Array.isArray(value.catalog_root.descriptors) ||
    value.catalog_root.descriptors.length > SKILL_LIMITS.packagesPerRoot ||
    value.catalog_root.catalog_hash !== expectedHash
  ) {
    return integrity();
  }
  const descriptors = value.catalog_root.descriptors.map((descriptor) => {
    const parsed = parseSkillDescriptor(canonicalJson(descriptor));
    if (!parsed.ok) return integrity();
    return parsed.value;
  });
  if (
    descriptors.some((descriptor, index) =>
      index === 0 ? false : descriptorOrder(descriptors[index - 1]!, descriptor) >= 0,
    ) ||
    hashSkillCatalog(
      descriptors.map((descriptor) => ({
        name: descriptor.name,
        version: descriptor.version,
        source: descriptor.source,
        package_hash: descriptor.package_hash,
        document_hash: descriptor.document_hash,
      })),
    ) !== expectedHash
  ) {
    return integrity();
  }
  return Object.freeze({
    schema_version: "skill-private-catalog-root.v1",
    catalog_root: deepFreezeJson({
      descriptors,
      catalog_hash: expectedHash,
    } as unknown as JsonValue) as unknown as SkillCatalogRoot,
  });
}

function journalHead(entry: RunJournalEntryV1) {
  return Object.freeze({
    journal_revision: entry.journal_revision,
    sequence: entry.sequence,
    entry_hash: entry.entry_hash,
  });
}

function journalPathLink(entry: RunJournalEntryV1): SkillJournalPathLinkV1 {
  return Object.freeze({
    run_id: entry.run_id,
    journal_revision: entry.journal_revision,
    sequence: entry.sequence,
    previous_entry_hash: entry.previous_entry_hash,
    entry_hash: entry.entry_hash,
    previous_state: entry.previous_state,
    state: entry.state,
    run_attempt: entry.run_attempt,
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

      const approvalProjections: Array<{
        request: ReturnType<typeof approvalRequest>;
        request_journal_entry: RunJournalEntryV1;
        decision: ReturnType<typeof decisionMetadata>["decision"] | null;
        decision_journal_entry: RunJournalEntryV1 | null;
      }> = [];
      const pendingByHead = new Map<
        `sha256:${string}`,
        {
          readonly entry: RunJournalEntryV1;
          readonly projection: (typeof approvalProjections)[number];
        }
      >();
      const approvalJournalHashes = new Set<`sha256:${string}`>();
      for (const entry of verified.journal.entries) {
        const metadata = entry.metadata;
        const kind =
          typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
            ? (metadata as Readonly<Record<string, JsonValue>>).kind
            : undefined;
        if (kind === "superpowers-approval-pending") {
          if (approvalProjections.length === 128) limitExceeded();
          const pending = pendingMetadata(entry);
          const projection = {
            request: approvalRequest(pending.phase, journalHead(entry)),
            request_journal_entry: entry,
            decision: null,
            decision_journal_entry: null,
          };
          approvalProjections.push(projection);
          approvalJournalHashes.add(entry.entry_hash);
          if (pendingByHead.has(entry.entry_hash)) integrity();
          pendingByHead.set(entry.entry_hash, { entry, projection });
        } else if (kind === "superpowers-approval-decision") {
          const pending = pendingByHead.get(entry.previous_entry_hash);
          if (pending === undefined || pending.projection.decision !== null) integrity();
          pending.projection.decision = decisionMetadata(entry, pending.entry).decision;
          pending.projection.decision_journal_entry = entry;
          approvalJournalHashes.add(entry.entry_hash);
        }
      }
      const approvals = approvalProjections.map((projection) => Object.freeze(projection));
      const terminalJournalEntry =
        zeroPhaseCode !== null && !approvalJournalHashes.has(finalJournal.entry_hash)
          ? finalJournal
          : null;
      if (verified.journal.entries.length > 1024) limitExceeded();
      const journalPath = verified.journal.entries.map(journalPathLink);

      const phaseByPackage = new Map<`sha256:${string}`, SuperpowersPhaseV1>();
      const catalogHashes = new Set<`sha256:${string}`>();
      for (const phase of verified.phases) {
        catalogHashes.add(phase.catalog_hash);
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
      if (catalogHashes.size > 256) limitExceeded();

      const preflight = {
        protocol_version: "runtime-contract.v1" as const,
        schema_version: "skill-execution-evidence.v1" as const,
        document_type: "skill-execution-evidence" as const,
        run_id: runId,
        journal_head: verified.journal.head,
        run_state: verified.journal.state,
        journal_path: journalPath,
        terminal_journal_entry: terminalJournalEntry,
        catalogs: [] as readonly SkillCatalogRoot[],
        snapshots: [] as readonly SkillSnapshotV1[],
        phases: verified.phases,
        approvals,
        terminal_code: zeroPhaseCode ?? verified.phases.at(-1)?.terminal_code ?? null,
      };
      let worstCaseBytes = Buffer.byteLength(evidenceJson(preflight), "utf8");
      const packageHashes = [...phaseByPackage.keys()].sort((left, right) =>
        Buffer.from(left).compare(Buffer.from(right)),
      );
      const orderedCatalogHashes = [...catalogHashes].sort((left, right) =>
        Buffer.from(left).compare(Buffer.from(right)),
      );
      const objectHashes = [...new Set([...orderedCatalogHashes, ...packageHashes])];
      for (const objectHash of objectHashes) {
        const bytes = await store.objectBytes(objectHash);
        if (bytes === null) integrity();
        worstCaseBytes += bytes;
        if (worstCaseBytes > SKILL_LIMITS.evidenceBytes) limitExceeded();
      }

      const catalogs: SkillCatalogRoot[] = [];
      for (const catalogHash of orderedCatalogHashes) {
        const bytes = await store.readObject(catalogHash);
        if (bytes === null) integrity();
        catalogs.push(publicCatalogRoot(bytes, catalogHash).catalog_root);
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

      const preimage = { ...preflight, catalogs, snapshots };
      let handoffHash: `sha256:${string}`;
      try {
        handoffHash = hashSkillExecutionHandoff(preimage);
      } catch {
        return limitExceeded();
      }
      const withHandoff = { ...preimage, handoff_hash: handoffHash };
      const candidate = {
        ...withHandoff,
        document_hash: hashSkillExecutionEvidence({
          ...withHandoff,
          document_hash: `sha256:${"0".repeat(64)}`,
        }),
      };
      const bytes = evidenceJson(candidate);
      if (Buffer.byteLength(bytes, "utf8") > SKILL_LIMITS.evidenceBytes) limitExceeded();
      const parsed = parseSkillExecutionEvidence(bytes);
      if (!parsed.ok) integrity();
      return parsed.value;
    },
  });
}
