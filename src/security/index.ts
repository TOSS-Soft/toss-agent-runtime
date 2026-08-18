import { UnavailableCapabilityError } from "../version.js";

export function requireSecurityRuntime(): never {
  throw new UnavailableCapabilityError("security");
}
