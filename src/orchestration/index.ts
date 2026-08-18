import { UnavailableCapabilityError } from "../version.js";

export function requireAgentLoop(): never {
  throw new UnavailableCapabilityError("orchestration");
}
