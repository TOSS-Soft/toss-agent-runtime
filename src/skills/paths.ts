import path from "node:path";

import { RuntimeSkillError } from "./errors.js";
import { SKILL_LIMITS } from "./types.js";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const RESERVED_BASENAMES = new Set([".git", ".toss", ".superpowers", ".stage", ".claim"]);

function unsafePath(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_PATH_UNSAFE");
}

export function assertConfiguredSkillRootPath(candidate: string): string {
  if (
    CONTROL_CHARACTER.test(candidate) ||
    !path.isAbsolute(candidate) ||
    path.normalize(candidate) !== candidate
  ) {
    unsafePath();
  }
  return candidate;
}

export function assertSkillRelativePath(candidate: string): string {
  if (
    candidate.length === 0 ||
    candidate.startsWith("/") ||
    candidate.includes("\\") ||
    CONTROL_CHARACTER.test(candidate)
  ) {
    unsafePath();
  }

  const components = candidate.split("/");
  if (components.length > SKILL_LIMITS.nestingDepth) unsafePath();
  for (const component of components) {
    if (
      component.length === 0 ||
      component === "." ||
      component === ".." ||
      RESERVED_BASENAMES.has(component)
    ) {
      unsafePath();
    }
  }
  return components.join("/");
}

export function portableSkillPath(candidate: string): string {
  return assertSkillRelativePath(candidate);
}
