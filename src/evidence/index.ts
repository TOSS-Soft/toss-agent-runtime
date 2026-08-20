import { UnavailableCapabilityError } from "../version.js";

export function requireEvidenceEmitter(): never {
  throw new UnavailableCapabilityError("evidence");
}
