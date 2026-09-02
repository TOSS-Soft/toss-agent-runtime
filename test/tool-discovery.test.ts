import { describe, expect, it, vi } from "vitest";

import type { McpProfileReference } from "../src/agents/types.js";
import { sha256 } from "../src/protocol/json.js";
import {
  createToolSessionManager,
  type ToolDiscoverySnapshotStore,
} from "../src/tools/discovery.js";
import type { McpProfileRegistry, RegisteredMcpProfile } from "../src/tools/profile.js";
import type {
  NativeToolDefinition,
  ToolListPage,
  ToolTransportAdapter,
  ToolTransportConnection,
} from "../src/tools/transports/types.js";
import type { McpProfileServerRuleV1, McpProfileV1, McpStdioBinding } from "../src/tools/types.js";
import { rehashMcpProfile, validMcpProfile } from "./support/tool-fixtures.js";

const EXECUTION_HASH = `sha256:${"8".repeat(64)}` as const;

function reference(profile: McpProfileV1): McpProfileReference {
  return {
    document_type: "mcp-profile",
    artifact_id: profile.profile_id,
    revision: profile.revision,
    hash: profile.document_hash,
  };
}

function stdioBinding(): McpStdioBinding {
  return {
    transport: "stdio",
    command: "/usr/bin/true",
    args: [],
    cwd: "/private/runtime",
    environment: {},
  };
}

function registered(profile: McpProfileV1 = validMcpProfile()): RegisteredMcpProfile {
  return Object.freeze({
    reference: Object.freeze(reference(profile)),
    profile,
    bindings: Object.freeze(
      Object.fromEntries(profile.servers.map((server) => [server.binding_name, stdioBinding()])),
    ),
    transports: Object.freeze(["stdio"] as const),
  });
}

function registry(profile: RegisteredMcpProfile): McpProfileRegistry {
  return Object.freeze({
    list: () => Object.freeze([profile]),
    resolve: (candidate: McpProfileReference) => {
      if (candidate.hash !== profile.reference.hash) throw new Error("profile not found");
      return profile;
    },
  });
}

function nativeTool(
  rule: McpProfileServerRuleV1["tools"][number],
  overrides: Partial<NativeToolDefinition> = {},
): NativeToolDefinition {
  return {
    name: rule.native_name,
    input_schema: rule.input_schema as NativeToolDefinition["input_schema"],
    output_schema: rule.output_schema as NativeToolDefinition["output_schema"],
    annotations: {
      read_only_hint: true,
      destructive_hint: false,
      idempotent_hint: true,
      open_world_hint: false,
    },
    ...overrides,
  };
}

function secondTool(server: McpProfileServerRuleV1) {
  const first = server.tools[0]!;
  return {
    ...first,
    alias: "repo.get",
    description: "Get one repository from the approved scope.",
    native_name: "get_repository",
  };
}

function profileWithTwoTools(): McpProfileV1 {
  const base = validMcpProfile();
  return rehashMcpProfile({
    ...base,
    servers: [
      {
        ...base.servers[0]!,
        tools: [secondTool(base.servers[0]!), base.servers[0]!.tools[0]!].sort((left, right) =>
          Buffer.from(left.alias).compare(Buffer.from(right.alias)),
        ),
      },
    ],
  });
}

interface ConnectionFixture {
  readonly pages: ReadonlyMap<string, ToolListPage>;
  readonly server_name?: string;
  readonly server_version?: string;
  readonly protocol_revision?: "2025-06-18" | "2026-07-28";
  readonly list_error?: Error;
  readonly on_list?: (cursor: string | null, signal: AbortSignal) => Promise<void> | void;
}

function pageKey(cursor: string | null): string {
  return cursor ?? "<first>";
}

function fakeAdapter(fixtures: readonly ConnectionFixture[], events: string[] = []) {
  let connectIndex = 0;
  let closeCount = 0;
  let listCount = 0;
  let change: (() => void) | undefined;
  const adapter: ToolTransportAdapter = {
    kind: "stdio",
    async connect(request) {
      await Promise.resolve();
      const fixture = fixtures[Math.min(connectIndex, fixtures.length - 1)]!;
      connectIndex += 1;
      change = request.on_tools_changed;
      const protocolRevision = fixture.protocol_revision ?? request.protocol_revision;
      const name = fixture.server_name ?? "github-mcp";
      const version = fixture.server_version ?? "1.0.0";
      const connection: ToolTransportConnection = {
        server: {
          name,
          version,
          identity_hash: sha256({ name, protocol_revision: protocolRevision, version }),
          protocol_revision: protocolRevision,
          transport: "stdio",
        },
        async listTools(cursor, signal) {
          listCount += 1;
          events.push(`list:${cursor ?? "first"}`);
          await fixture.on_list?.(cursor, signal);
          if (fixture.list_error !== undefined) throw fixture.list_error;
          const page = fixture.pages.get(pageKey(cursor));
          if (page === undefined) throw new Error("unexpected cursor");
          return page;
        },
        callTool: () => Promise.reject(new Error("not used")),
        close() {
          closeCount += 1;
          events.push("close");
          return Promise.resolve();
        },
      };
      return Object.freeze(connection);
    },
  };
  return {
    adapter: Object.freeze(adapter),
    triggerListChanged: () => change?.(),
    connectCount: () => connectIndex,
    closeCount: () => closeCount,
    listCount: () => listCount,
  };
}

function defaultPages(profile: McpProfileV1): ReadonlyMap<string, ToolListPage> {
  const server = profile.servers[0]!;
  const tools = server.tools.map((tool) => nativeTool(tool));
  if (tools.length === 1) {
    return new Map([["<first>", { tools, next_cursor: null }]]);
  }
  return new Map([
    ["<first>", { tools: tools.slice(1), next_cursor: tools.length > 1 ? "page-2" : null }],
    ["page-2", { tools: tools.slice(0, 1), next_cursor: null }],
  ]);
}

function store(events: string[] = []) {
  const snapshots: unknown[] = [];
  const value: ToolDiscoverySnapshotStore = {
    publish(snapshot) {
      events.push("persist:snapshot");
      snapshots.push(snapshot);
      return Promise.resolve();
    },
  };
  return { value, snapshots };
}

function managerFixture(
  options: {
    readonly profile?: McpProfileV1;
    readonly adapters?: Readonly<Record<string, ToolTransportAdapter>>;
    readonly snapshot_store?: ToolDiscoverySnapshotStore;
    readonly now?: () => Date;
  } = {},
) {
  const profile = options.profile ?? validMcpProfile();
  const fallback = fakeAdapter([{ pages: defaultPages(profile) }]);
  return createToolSessionManager({
    profile_registry: registry(registered(profile)),
    adapters: options.adapters ?? { github: fallback.adapter },
    snapshot_store: options.snapshot_store ?? store().value,
    now: options.now ?? (() => new Date("2026-09-01T10:00:00.000Z")),
    create_session_id: () => "session-001",
  });
}

describe("run-scoped MCP discovery sessions", () => {
  it("paginates, normalizes, persists, then exposes only profile-owned metadata", async () => {
    const profile = profileWithTwoTools();
    const events: string[] = [];
    const persistence = store(events);
    const adapter = fakeAdapter([{ pages: defaultPages(profile) }], events);
    const manager = managerFixture({
      profile,
      adapters: { github: adapter.adapter },
      snapshot_store: persistence.value,
    });
    const session = manager.openSession({
      run_id: "run-1",
      execution_request_hash: EXECUTION_HASH,
      profile: reference(profile),
    });
    const view = await session.discover(new AbortController().signal);

    expect(events).toEqual(["list:first", "list:page-2", "persist:snapshot"]);
    expect(view.tools.map((tool) => tool.alias)).toEqual(["repo.get", "repo.search"]);
    expect(view.tools[1]).toMatchObject({
      alias: "repo.search",
      description: "Search repositories allowed by the task.",
      input_schema: profile.servers[0]!.tools[1]!.input_schema,
    });
    expect(view.tools[1]).not.toHaveProperty("native_name");
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.tools)).toBe(true);
    expect(session.snapshot()?.document_hash).toBe(view.discovery_snapshot_hash);
    expect(persistence.snapshots).toHaveLength(1);
  });

  it("reuses one exact run/profile session without cross-run reuse", () => {
    let next = 0;
    const profile = validMcpProfile();
    const adapter = fakeAdapter([{ pages: defaultPages(profile) }]);
    const manager = createToolSessionManager({
      profile_registry: registry(registered(profile)),
      adapters: { github: adapter.adapter },
      snapshot_store: store().value,
      now: () => new Date("2026-09-01T10:00:00.000Z"),
      create_session_id: () => `session-${++next}`,
    });
    const input = {
      run_id: "run-1",
      execution_request_hash: EXECUTION_HASH,
      profile: reference(profile),
    } as const;
    const first = manager.openSession(input);
    expect(manager.openSession(input)).toBe(first);
    expect(manager.openSession({ ...input, run_id: "run-2" })).not.toBe(first);
    expect(() =>
      manager.openSession({
        ...input,
        execution_request_hash: `sha256:${"7".repeat(64)}`,
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_OPERATION_CONFLICT" }));
  });

  it.each([
    [
      "duplicate cursor",
      new Map([
        ["<first>", { tools: [], next_cursor: "again" }],
        ["again", { tools: [], next_cursor: "again" }],
      ]),
    ],
    [
      "duplicate native tool",
      new Map([
        [
          "<first>",
          {
            tools: [
              nativeTool(validMcpProfile().servers[0]!.tools[0]!),
              nativeTool(validMcpProfile().servers[0]!.tools[0]!),
            ],
            next_cursor: null,
          },
        ],
      ]),
    ],
  ] as const)("fails closed on %s", async (_name, pages) => {
    const profile = validMcpProfile();
    const adapter = fakeAdapter([{ pages }]);
    const session = managerFixture({ adapters: { github: adapter.adapter } }).openSession({
      run_id: "run-1",
      execution_request_hash: EXECUTION_HASH,
      profile: reference(profile),
    });
    await expect(session.discover(new AbortController().signal)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_RESULT_INVALID",
    });
  });

  it.each(["page limit", "tool limit", "schema limit"] as const)(
    "enforces the profile %s",
    async (kind) => {
      const base = validMcpProfile();
      const profile = rehashMcpProfile({
        ...base,
        limits: {
          ...base.limits,
          ...(kind === "page limit" ? { discovery_pages_per_server: 1 } : {}),
          ...(kind === "tool limit" ? { tools_per_server: 1 } : {}),
        },
      });
      const approved = nativeTool(profile.servers[0]!.tools[0]!);
      const extra = nativeTool(profile.servers[0]!.tools[0]!, {
        name: "unapproved_extra",
        ...(kind === "schema limit"
          ? {
              input_schema: {
                type: "object",
                description: "x".repeat(profile.limits.schema_bytes),
              },
            }
          : {}),
      });
      const pages =
        kind === "page limit"
          ? new Map([
              ["<first>", { tools: [], next_cursor: "second" }],
              ["second", { tools: [approved], next_cursor: null }],
            ])
          : new Map([["<first>", { tools: [approved, extra], next_cursor: null }]]);
      const adapter = fakeAdapter([{ pages }]);
      const session = managerFixture({
        profile,
        adapters: { github: adapter.adapter },
      }).openSession({
        run_id: "run-1",
        execution_request_hash: EXECUTION_HASH,
        profile: reference(profile),
      });
      await expect(session.discover(new AbortController().signal)).rejects.toMatchObject({
        code: "RUNTIME_TOOL_RESULT_INVALID",
      });
    },
  );

  it.each([
    ["timeout", false, "RUNTIME_TOOL_TIMEOUT"],
    ["cancellation", true, "RUNTIME_TOOL_CANCELLED"],
  ] as const)("propagates discovery %s", async (_name, cancel, code) => {
    const base = validMcpProfile();
    const profile = rehashMcpProfile({
      ...base,
      limits: { ...base.limits, discovery_timeout_ms: 20 },
    });
    const adapter = fakeAdapter([
      {
        pages: defaultPages(profile),
        on_list: async (_cursor, signal) =>
          await new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("native cancellation detail")),
              { once: true },
            );
          }),
      },
    ]);
    const session = managerFixture({ profile, adapters: { github: adapter.adapter } }).openSession({
      run_id: "run-1",
      execution_request_hash: EXECUTION_HASH,
      profile: reference(profile),
    });
    const controller = new AbortController();
    const pending = session.discover(controller.signal);
    if (cancel) controller.abort();
    await expect(pending).rejects.toMatchObject({ code });
  });

  it("rejects live schema drift and a riskier native annotation", async () => {
    const profile = validMcpProfile();
    const rule = profile.servers[0]!.tools[0]!;
    for (const candidate of [
      nativeTool(rule, {
        input_schema: { ...rule.input_schema, additionalProperties: true },
      }),
      nativeTool(rule, {
        annotations: {
          read_only_hint: false,
          destructive_hint: false,
          idempotent_hint: true,
          open_world_hint: false,
        },
      }),
    ]) {
      const adapter = fakeAdapter([
        { pages: new Map([["<first>", { tools: [candidate], next_cursor: null }]]) },
      ]);
      const session = managerFixture({ adapters: { github: adapter.adapter } }).openSession({
        run_id: "run-1",
        execution_request_hash: EXECUTION_HASH,
        profile: reference(profile),
      });
      await expect(session.discover(new AbortController().signal)).rejects.toMatchObject({
        code: "RUNTIME_TOOL_SCHEMA_MISMATCH",
      });
    }
  });

  it("accepts a less-risky native hint while preserving profile operation class", async () => {
    const base = validMcpProfile();
    const profile = rehashMcpProfile({
      ...base,
      servers: [
        {
          ...base.servers[0]!,
          tools: [
            {
              ...base.servers[0]!.tools[0]!,
              operation_class: "irreversible" as const,
              approval: "required" as const,
            },
          ],
        },
      ],
    });
    const adapter = fakeAdapter([{ pages: defaultPages(profile) }]);
    const session = managerFixture({ profile, adapters: { github: adapter.adapter } }).openSession({
      run_id: "run-1",
      execution_request_hash: EXECUTION_HASH,
      profile: reference(profile),
    });
    const view = await session.discover(new AbortController().signal);
    expect(session.snapshot()?.servers[0]?.tools[0]?.operation_class).toBe("irreversible");
    expect(view.tools).toHaveLength(1);
  });

  it("marks list changes stale and rejects a changed producer on rediscovery", async () => {
    const profile = validMcpProfile();
    const adapter = fakeAdapter([
      { pages: defaultPages(profile) },
      { pages: defaultPages(profile), server_version: "2.0.0" },
    ]);
    const session = managerFixture({ adapters: { github: adapter.adapter } }).openSession({
      run_id: "run-1",
      execution_request_hash: EXECUTION_HASH,
      profile: reference(profile),
    });
    await session.discover(new AbortController().signal);
    adapter.triggerListChanged();
    expect(session.snapshot()?.stale).toBe(true);
    await expect(session.discover(new AbortController().signal)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_PROTOCOL_DOWNGRADE",
    });
    expect(adapter.connectCount()).toBe(2);
  });

  it("publishes no partial snapshot when one configured server fails", async () => {
    const base = validMcpProfile();
    const first = base.servers[0]!;
    const secondServer = {
      ...first,
      server_id: "gitlab",
      binding_name: "gitlab",
      tools: [
        {
          ...first.tools[0]!,
          alias: "gitlab.search",
          native_name: "search_gitlab",
        },
      ],
    };
    const profile = rehashMcpProfile({
      ...base,
      servers: [first, secondServer].sort((left, right) =>
        Buffer.from(left.server_id).compare(Buffer.from(right.server_id)),
      ),
    });
    const github = fakeAdapter([{ pages: defaultPages(profile) }]);
    const gitlab = fakeAdapter([
      { pages: new Map(), list_error: new Error("native server secret") },
    ]);
    const persistence = store();
    const session = managerFixture({
      profile,
      adapters: { github: github.adapter, gitlab: gitlab.adapter },
      snapshot_store: persistence.value,
    }).openSession({
      run_id: "run-1",
      execution_request_hash: EXECUTION_HASH,
      profile: reference(profile),
    });

    await expect(session.discover(new AbortController().signal)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_UNAVAILABLE",
    });
    expect(persistence.snapshots).toHaveLength(0);
    expect(session.snapshot()).toBeNull();
    expect(github.closeCount()).toBe(1);
  });

  it("does not expose a snapshot before durable publication succeeds", async () => {
    const profile = validMcpProfile();
    const adapter = fakeAdapter([{ pages: defaultPages(profile) }]);
    const snapshotStore: ToolDiscoverySnapshotStore = {
      publish: () => Promise.reject(new Error("disk detail must not leak")),
    };
    const session = managerFixture({
      adapters: { github: adapter.adapter },
      snapshot_store: snapshotStore,
    }).openSession({
      run_id: "run-1",
      execution_request_hash: EXECUTION_HASH,
      profile: reference(profile),
    });
    await expect(session.discover(new AbortController().signal)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_UNAVAILABLE",
    });
    expect(session.snapshot()).toBeNull();
  });

  it("serializes concurrent discovery and refuses an expired session", async () => {
    const profile = validMcpProfile();
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let entered = 0;
    let current = new Date("2026-09-01T10:00:00.000Z");
    const adapter = fakeAdapter([
      {
        pages: defaultPages(profile),
        on_list: async () => {
          entered += 1;
          await gate;
        },
      },
    ]);
    const session = managerFixture({
      adapters: { github: adapter.adapter },
      now: () => current,
    }).openSession({
      run_id: "run-1",
      execution_request_hash: EXECUTION_HASH,
      profile: reference(profile),
    });
    const first = session.discover(new AbortController().signal);
    const second = session.discover(new AbortController().signal);
    await vi.waitFor(() => expect(entered).toBe(1));
    resolveGate();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(adapter.connectCount()).toBe(1);
    expect(adapter.listCount()).toBe(1);

    current = new Date("2026-09-01T10:05:00.001Z");
    await expect(session.discover(new AbortController().signal)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_UNAVAILABLE",
    });
  });
});
