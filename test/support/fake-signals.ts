import type { RuntimeSignal, SignalSource } from "../../src/platform/signals.js";

export class FakeSignals implements SignalSource {
  private readonly listeners = new Map<RuntimeSignal, Set<() => void>>();

  subscribe(signal: RuntimeSignal, listener: () => void): () => void {
    const entries = this.listeners.get(signal) ?? new Set<() => void>();
    entries.add(listener);
    this.listeners.set(signal, entries);
    return () => entries.delete(listener);
  }

  emit(signal: RuntimeSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }

  count(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}
