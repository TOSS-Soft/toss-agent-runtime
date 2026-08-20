import { UnavailableCapabilityError } from "../version.js";

export function requireAgentRegistry(): never {
  throw new UnavailableCapabilityError("agents");
}
