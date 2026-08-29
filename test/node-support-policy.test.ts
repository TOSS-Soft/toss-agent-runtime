import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface WorkflowJob {
  readonly name?: string;
  readonly "runs-on"?: string;
  readonly strategy?: unknown;
  readonly steps?: readonly WorkflowStep[];
}

interface Workflow {
  readonly on?: {
    readonly push?: { readonly branches?: readonly string[] };
    readonly schedule?: readonly { readonly cron?: string }[];
  };
  readonly jobs?: Readonly<Record<string, WorkflowJob>>;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readWorkflow(path: string): Promise<Workflow> {
  return parse(await readFile(path, "utf8")) as Workflow;
}

function expectLatestLtsJob(job: WorkflowJob | undefined): void {
  expect(job).toBeDefined();
  expect(job?.["runs-on"]).toBe("macos-latest");
  expect(job?.strategy).toBeUndefined();

  const setup = job?.steps?.find((step) => step.uses?.startsWith("actions/setup-node@"));
  expect(setup?.with?.["node-version"]).toBe("lts/*");
  expect(setup?.with?.["check-latest"]).toBe(true);

  const runtimeCheck = job?.steps?.find((step) => step.name === "Confirm Latest LTS runtime");
  expect(runtimeCheck?.run).toContain("process.release.lts");
}

describe("Node.js support policy", () => {
  it("runs one automatically advancing Latest LTS lane on macOS", async () => {
    const ci = await readWorkflow(".github/workflows/ci.yml");
    const release = await readWorkflow(".github/workflows/release.yml");

    expect(Object.keys(ci.jobs ?? {})).toEqual(["verify"]);
    expectLatestLtsJob(ci.jobs?.verify);
    expect(ci.on?.push?.branches).toEqual(["main", "release/v1.0.0"]);
    expect(ci.on?.schedule).toEqual([{ cron: "17 4 * * 1" }]);

    expect(Object.keys(release.jobs ?? {})).toEqual(["verify-only"]);
    expectLatestLtsJob(release.jobs?.["verify-only"]);
  });

  it("keeps package and current support documentation aligned", async () => {
    const packageManifest = (await readJson("package.json")) as {
      readonly devDependencies?: Readonly<Record<string, string>>;
      readonly engines?: { readonly node?: string };
    };
    const lockfile = (await readJson("package-lock.json")) as {
      readonly packages?: Readonly<
        Record<
          string,
          {
            readonly devDependencies?: Readonly<Record<string, string>>;
            readonly engines?: { readonly node?: string };
          }
        >
      >;
    };
    const currentPolicyFiles = [
      "README.md",
      "docs/superpowers/specs/2026-08-19-durable-local-service-design.md",
      "docs/superpowers/specs/2026-08-20-agentgateway-transport-design.md",
      "docs/superpowers/specs/2026-08-20-v1-release-program-design.md",
      "docs/superpowers/specs/2026-08-21-governed-model-routing-design.md",
    ];

    expect(packageManifest.engines?.node).toBe(">=24");
    expect(lockfile.packages?.[""]?.engines?.node).toBe(packageManifest.engines?.node);
    expect(packageManifest.devDependencies?.["@types/node"]).toMatch(/^24\./);
    expect(lockfile.packages?.[""]?.devDependencies?.["@types/node"]).toBe(
      packageManifest.devDependencies?.["@types/node"],
    );

    for (const path of currentPolicyFiles) {
      const contents = await readFile(path, "utf8");
      expect(contents, path).toContain("latest Node.js LTS");
      expect(contents, path).not.toMatch(/Node(?:\.js)? (?:22|24)(?:\.23\.1|\/24| and Node)/);
    }
  });
});
