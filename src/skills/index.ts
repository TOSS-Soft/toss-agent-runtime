import { UnavailableCapabilityError } from "../version.js";

export function requireSkillsHost(): never {
  throw new UnavailableCapabilityError("skills");
}
