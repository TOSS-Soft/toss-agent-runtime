import { UnavailableCapabilityError } from "../version.js";

export function requireModelRouter(): never {
  throw new UnavailableCapabilityError("routing");
}
