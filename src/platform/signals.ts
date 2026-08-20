export type RuntimeSignal = "SIGINT" | "SIGTERM";

export interface SignalSource {
  subscribe(signal: RuntimeSignal, listener: () => void): () => void;
}

export function createProcessSignalSource(): SignalSource {
  return {
    subscribe(signal, listener) {
      process.on(signal, listener);
      return () => process.off(signal, listener);
    },
  };
}
