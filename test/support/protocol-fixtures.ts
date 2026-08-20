import { readFile } from "node:fs/promises";

import {
  parseRuntimeCapabilities,
  type RuntimeCapabilitiesV1,
} from "../../src/protocol/capabilities.js";
import { parseExecutionEvent, type ExecutionEventV1 } from "../../src/protocol/event.js";
import { parseExecutionRequest, type ExecutionRequestV1 } from "../../src/protocol/request.js";
import { parseExecutionResult, type ExecutionResultV1 } from "../../src/protocol/result.js";

async function requireValid<T>(
  path: string,
  parse: (input: Uint8Array) => { readonly ok: true; readonly value: T } | { readonly ok: false },
): Promise<T> {
  const result = parse(await readFile(path));
  if (!result.ok) {
    throw new Error(`Valid fixture was rejected: ${path}`);
  }
  return result.value;
}

export async function loadValidChain(): Promise<{
  readonly request: ExecutionRequestV1;
  readonly events: readonly ExecutionEventV1[];
  readonly result: ExecutionResultV1;
  readonly capabilities: RuntimeCapabilitiesV1;
}> {
  return {
    request: await requireValid(
      "test/fixtures/protocol/valid/execution-request.v1.json",
      parseExecutionRequest,
    ),
    events: [
      await requireValid(
        "test/fixtures/protocol/valid/execution-event.v1.json",
        parseExecutionEvent,
      ),
    ],
    result: await requireValid(
      "test/fixtures/protocol/valid/execution-result.v1.json",
      parseExecutionResult,
    ),
    capabilities: await requireValid(
      "test/fixtures/protocol/valid/runtime-capabilities.v1.json",
      parseRuntimeCapabilities,
    ),
  };
}
