import { describe, expect, it } from "vitest";

import { hashModelCatalog, parseModelCatalog } from "../src/routing/contracts.js";
import { routingRuntimeError } from "../src/routing/errors.js";
import { catalogBytes, catalogDocumentHash, validCatalog } from "./helpers/routing-fixtures.js";

function parsedCatalog(value: Record<string, unknown>) {
  return parseModelCatalog(catalogBytes(value));
}

function expectInvalid(value: Record<string, unknown>) {
  expect(parsedCatalog(value)).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
}

describe("model catalog contract", () => {
  it("parses the canonical catalog, binds its exact order, and deeply freezes it", () => {
    const catalog = validCatalog();
    const parsed = parsedCatalog(catalog);

    expect(parsed).toMatchObject({
      ok: true,
      value: { document_hash: catalogDocumentHash(catalog) },
    });
    if (!parsed.ok) return;

    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.entries)).toBe(true);
    expect(Object.isFrozen(parsed.value.entries[0]?.routes)).toBe(true);
    expect(hashModelCatalog(parsed.value)).toBe(catalogDocumentHash(catalog));

    const reordered = {
      ...catalog,
      entries: [
        {
          ...((catalog.entries as Record<string, unknown>[])[0] as Record<string, unknown>),
          routes: [
            ...(((catalog.entries as Record<string, unknown>[])[0] as Record<string, unknown>)
              .routes as unknown[]),
          ].reverse(),
        },
      ],
    };
    expect(catalogDocumentHash(reordered)).not.toBe(catalogDocumentHash(catalog));
  });

  it("accepts the six closed logical classes in any order", () => {
    const catalog = validCatalog();
    catalog.entries = [
      {
        ...(catalog.entries as Record<string, unknown>[])[0],
        logical_classes: [
          "vision",
          "independent-review",
          "deep-reasoning",
          "economy",
          "long-context",
          "balanced-code",
        ],
      },
    ];

    expect(parsedCatalog(catalog)).toMatchObject({ ok: true });
  });

  it("rejects a document hash that does not bind canonical catalog content", () => {
    const catalog = validCatalog();
    expect(
      parseModelCatalog(JSON.stringify({ ...catalog, document_hash: `sha256:${"f".repeat(64)}` })),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });

  it("rejects duplicate entry IDs", () => {
    const catalog = validCatalog();
    catalog.entries = [...(catalog.entries as unknown[]), (catalog.entries as unknown[])[0]];
    expectInvalid(catalog);
  });

  it("rejects duplicate route IDs across entries", () => {
    const catalog = validCatalog();
    const entry = (catalog.entries as Record<string, unknown>[])[0] as Record<string, unknown>;
    catalog.entries = [entry, { ...entry, entry_id: "balanced-secondary" }];
    expectInvalid(catalog);
  });

  it("rejects duplicate logical classes in an entry", () => {
    const catalog = validCatalog();
    const entry = (catalog.entries as Record<string, unknown>[])[0] as Record<string, unknown>;
    catalog.entries = [{ ...entry, logical_classes: ["economy", "economy"] }];
    expectInvalid(catalog);
  });

  it("rejects an unsafe route alias", () => {
    const catalog = validCatalog();
    const entry = (catalog.entries as Record<string, unknown>[])[0] as Record<string, unknown>;
    catalog.entries = [{ ...entry, route_alias: "balanced code" }];
    expectInvalid(catalog);
  });

  it("rejects a route with a mismatched capability provider", () => {
    const catalog = validCatalog();
    const entry = (catalog.entries as Record<string, unknown>[])[0] as Record<string, unknown>;
    const route = (entry.routes as Record<string, unknown>[])[0] as Record<string, unknown>;
    catalog.entries = [
      {
        ...entry,
        routes: [
          { ...route, capabilities: { ...(route.capabilities as object), provider: "openai" } },
        ],
      },
    ];
    expectInvalid(catalog);
  });

  it("rejects missing or unsafe price fields", () => {
    const missing = validCatalog();
    const entry = (missing.entries as Record<string, unknown>[])[0] as Record<string, unknown>;
    const route = (entry.routes as Record<string, unknown>[])[0] as Record<string, unknown>;
    const { output_microusd_per_million: _output, ...pricing } = route.pricing as Record<
      string,
      unknown
    >;
    missing.entries = [{ ...entry, routes: [{ ...route, pricing }] }];
    expectInvalid(missing);

    const unsafe = validCatalog();
    const unsafeEntry = (unsafe.entries as Record<string, unknown>[])[0] as Record<string, unknown>;
    const unsafeRoute = (unsafeEntry.routes as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
    unsafe.entries = [
      {
        ...unsafeEntry,
        routes: [
          {
            ...unsafeRoute,
            pricing: {
              ...(unsafeRoute.pricing as object),
              input_microusd_per_million: Number.MAX_SAFE_INTEGER + 1,
            },
          },
        ],
      },
    ];
    expectInvalid(unsafe);
  });

  it("rejects unknown fields and duplicate JSON keys", () => {
    expectInvalid({ ...validCatalog(), unexpected: true });
    const bytes = catalogBytes(validCatalog()).replace(
      '"catalog_id":"catalog-production"',
      '"catalog_id":"catalog-production","catalog_id":"catalog-production"',
    );
    expect(parseModelCatalog(bytes)).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });

  it("rejects more than 1024 entries and input over two MiB", () => {
    const catalog = validCatalog();
    const entry = (catalog.entries as unknown[])[0];
    catalog.entries = Array.from({ length: 1025 }, (_, index) => ({
      ...(entry as Record<string, unknown>),
      entry_id: `entry-${index}`,
      routes: [
        {
          ...((entry as Record<string, unknown>).routes as Record<string, unknown>[])[0],
          route_id: `route-${index}`,
        },
      ],
    }));
    expect(
      parseModelCatalog(JSON.stringify({ ...catalog, document_hash: `sha256:${"0".repeat(64)}` })),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });

    expect(parseModelCatalog(" ".repeat(2 * 1024 * 1024 + 1))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });

  it("returns fixed non-reflective routing errors", () => {
    expect(routingRuntimeError("RUNTIME_ROUTING_CIRCUIT_OPEN")).toEqual({
      code: "RUNTIME_ROUTING_CIRCUIT_OPEN",
      category: "unavailable",
      retryable: true,
      safe_message: "Routing circuit is open",
    });
    expect(routingRuntimeError("RUNTIME_ROUTING_RESOLUTION_MISMATCH")).toEqual({
      code: "RUNTIME_ROUTING_RESOLUTION_MISMATCH",
      category: "integrity",
      retryable: false,
      safe_message: "Resolved route does not match the plan",
    });
  });
});
