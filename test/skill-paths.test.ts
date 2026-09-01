import { describe, expect, it } from "vitest";

import {
  assertConfiguredSkillRootPath,
  assertSkillRelativePath,
  portableSkillPath,
} from "../src/skills/paths.js";
import { RuntimeSkillError } from "../src/skills/errors.js";

describe("skill paths", () => {
  it("accepts an absolute normalized configured root", () => {
    expect(assertConfiguredSkillRootPath("/opt/toss/skills")).toBe("/opt/toss/skills");
  });

  it.each(["relative/skills", "/opt/toss/../skills", "/opt/toss\u0000/skills"])(
    "rejects an unsafe configured root %j",
    (candidate) => {
      expect(() => assertConfiguredSkillRootPath(candidate)).toThrowError(
        new RuntimeSkillError("RUNTIME_SKILL_PATH_UNSAFE"),
      );
    },
  );

  it("returns a portable skill resource path unchanged", () => {
    expect(assertSkillRelativePath("references/guide.md")).toBe("references/guide.md");
    expect(portableSkillPath("assets/logo.svg")).toBe("assets/logo.svg");
  });

  it.each([
    "../escape",
    "/absolute",
    "refs//x",
    "refs/./x",
    "refs/a/../../x",
    String.raw`refs\x`,
    "one/two/three/four/five/six/seven/eight/nine",
    ".git/config",
    "references/.toss/state",
    "assets/.superpowers/plan",
    ".stage/entry",
    "scripts/.claim/entry",
    "refs/unsafe\u0000-name",
  ])("rejects unsafe resource path %s", (candidate) => {
    expect(() => assertSkillRelativePath(candidate)).toThrowError(
      new RuntimeSkillError("RUNTIME_SKILL_PATH_UNSAFE"),
    );
  });
});
