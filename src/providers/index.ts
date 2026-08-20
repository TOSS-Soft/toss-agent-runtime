import { UnavailableCapabilityError } from "../version.js";

export function requireProviderRuntime(): never {
  throw new UnavailableCapabilityError("providers");
}
