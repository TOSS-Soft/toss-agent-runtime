import type { CandidateJobIntentV1, ProjectChange, ProjectRegistration } from "./types.js";

export interface ProjectRegistry {
  recover(): Promise<void>;
  register(root: string, operationId?: string): Promise<ProjectRegistration>;
  unregister(projectId: string, operationId?: string): Promise<ProjectRegistration>;
  blockUnavailable(projectId: string, operationId?: string): Promise<ProjectRegistration>;
  list(): Promise<readonly ProjectRegistration[]>;
  get(projectId: string): Promise<ProjectRegistration | null>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}

export interface ProjectIntake {
  record(registration: ProjectRegistration, change: ProjectChange): Promise<void>;
  recover(registrations: readonly ProjectRegistration[]): Promise<void>;
  discard(projectId: string): Promise<void>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
  listCandidates(): Promise<readonly CandidateJobIntentV1[]>;
}
