import { sha256 } from "../protocol/json.js";
import { sensitiveMetadataIssues } from "../protocol/metadata.js";
import type { ValidationResult } from "../protocol/types.js";
import { createProtocolValidator } from "../protocol/validator.js";
import type { HashableRunJournalEntryV1, RunJournalEntryV1 } from "./types.js";

export const ZERO_JOURNAL_HASH = `sha256:${"0".repeat(64)}` as const;

export function hashRunJournalEntry(entry: HashableRunJournalEntryV1): `sha256:${string}` {
  return sha256(entry);
}

function invalidIssue(
  path: string,
  keyword: string,
  message: string,
): ValidationResult<RunJournalEntryV1> {
  return {
    ok: false,
    code: "RUNTIME_DOCUMENT_INVALID",
    issues: [{ path, keyword, message }],
  };
}

export function parseRunJournalEntry(
  input: string | Uint8Array,
): ValidationResult<RunJournalEntryV1> {
  const result = createProtocolValidator().parse<RunJournalEntryV1>(input, "run-journal-entry");
  if (!result.ok) return result;

  const metadataIssues = sensitiveMetadataIssues(result.value.metadata, "/metadata");
  if (metadataIssues.length > 0) {
    return { ok: false, code: "RUNTIME_DOCUMENT_INVALID", issues: metadataIssues };
  }

  const sideEffect = result.value.side_effect;
  if (
    (sideEffect === null && result.value.operation_id !== null) ||
    (sideEffect !== null && result.value.operation_id !== sideEffect.identity)
  ) {
    return invalidIssue("/side_effect/identity", "operationIdentity", "must equal operation_id");
  }

  const { entry_hash: entryHash, ...hashable } = result.value;
  if (hashRunJournalEntry(hashable) !== entryHash) {
    return invalidIssue(
      "/entry_hash",
      "contentHash",
      "must match the canonical journal entry content",
    );
  }
  return result;
}
