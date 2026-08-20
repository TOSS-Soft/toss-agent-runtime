export type ProjectRegistryState = "ACTIVE" | "UNREGISTERED" | "BLOCKED_PROJECT_UNAVAILABLE";

export type ProjectChangeKind = "CREATED" | "CHANGED" | "REMOVED";

export interface ProjectWatchManifestV1 {
  readonly schema_version: "project-watch-manifest.v1";
  readonly watch_paths: readonly string[];
  readonly ignore_paths: readonly string[];
}

export interface HashableProjectRegistryEntryV1 {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "project-registry-entry.v1";
  readonly document_type: "project-registry-entry";
  readonly registry_revision: number;
  readonly previous_entry_hash: `sha256:${string}`;
  readonly project_id: string;
  readonly canonical_root: string;
  readonly manifest_hash: `sha256:${string}`;
  readonly state: ProjectRegistryState;
  readonly reason_code: string;
  readonly timestamp: string;
}

export interface ProjectRegistryEntryV1 extends HashableProjectRegistryEntryV1 {
  readonly entry_hash: `sha256:${string}`;
}

export interface ProjectFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly mtime_ns: string;
  readonly size: string;
}

export interface ProjectChange {
  readonly kind: ProjectChangeKind;
  readonly path: string;
  readonly identity: ProjectFileIdentity | null;
}

export interface CandidateJobIntentV1 {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "candidate-job-intent.v1";
  readonly document_type: "candidate-job-intent";
  readonly candidate_key: `sha256:${string}`;
  readonly kind: "PROJECT_CHANGED";
  readonly project_id: string;
  readonly registry_revision: number;
  readonly manifest_hash: `sha256:${string}`;
  readonly changes: readonly ProjectChange[];
  readonly created_at: string;
}

export interface ProjectRegistration {
  readonly project_id: string;
  readonly registry_revision: number;
  readonly canonical_root: string;
  readonly manifest_hash: `sha256:${string}`;
  readonly state: ProjectRegistryState;
}

export interface ProjectPendingWindowV1 {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "project-pending-window.v1";
  readonly document_type: "project-pending-window";
  readonly project_id: string;
  readonly registry_revision: number;
  readonly canonical_root: string;
  readonly manifest_hash: `sha256:${string}`;
  readonly opened_at: string;
  readonly updated_at: string;
  readonly deadline_at: string;
  readonly changes: readonly ProjectChange[];
}
