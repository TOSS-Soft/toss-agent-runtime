import { UnavailableCapabilityError } from "../version.js";

export function requireToolBroker(): never {
  throw new UnavailableCapabilityError("tools");
}
