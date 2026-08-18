export const PACKAGE_NAME = "@toss-software/agent-runtime" as const;
export const PACKAGE_VERSION = "0.0.0-development" as const;
export const PROTOCOL_VERSION = "runtime-contract.v1" as const;

export class UnavailableCapabilityError extends Error {
  readonly code = "RUNTIME_CAPABILITY_UNAVAILABLE";

  constructor(readonly capability: string) {
    super(`Capability is unavailable in this build: ${capability}`);
    this.name = "UnavailableCapabilityError";
  }
}
