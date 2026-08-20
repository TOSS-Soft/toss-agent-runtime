import type { RuntimeSignal, SignalSource } from "../platform/signals.js";

export interface ServiceOutcome {
  readonly reason: RuntimeSignal | "requested";
  readonly forced: boolean;
}

export interface ServiceController {
  readonly accepting: boolean;
  stop(reason: RuntimeSignal | "requested"): Promise<ServiceOutcome>;
}

export function runService(options: {
  readonly signals: SignalSource;
  readonly stopAccepting: () => void;
  readonly drain: (signal: AbortSignal) => Promise<void>;
  readonly shutdownTimeoutMs: number;
}): Promise<ServiceOutcome> {
  return new Promise<ServiceOutcome>((resolve, reject) => {
    let stopPromise: Promise<ServiceOutcome> | undefined;
    const unsubscribe: (() => void)[] = [];
    const keepAlive = setInterval(() => undefined, 86_400_000);

    const cleanup = (): void => {
      clearInterval(keepAlive);
      for (const remove of unsubscribe.splice(0)) remove();
    };

    const stop = (reason: RuntimeSignal): void => {
      if (stopPromise !== undefined) return;
      stopPromise = (async () => {
        const controller = new AbortController();
        let timer: NodeJS.Timeout | undefined;

        try {
          options.stopAccepting();
          const drainPromise = options.drain(controller.signal);
          const timeoutPromise = new Promise<"forced">((resolveTimeout) => {
            timer = setTimeout(() => {
              controller.abort();
              resolveTimeout("forced");
            }, options.shutdownTimeoutMs);
          });
          const outcome = await Promise.race([
            drainPromise.then(() => "drained" as const),
            timeoutPromise,
          ]);
          if (outcome === "forced") {
            void drainPromise.catch(() => undefined);
          }
          return { reason, forced: outcome === "forced" };
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          cleanup();
        }
      })();
      void stopPromise.then(resolve, reject);
    };

    try {
      unsubscribe.push(options.signals.subscribe("SIGINT", () => stop("SIGINT")));
      unsubscribe.push(options.signals.subscribe("SIGTERM", () => stop("SIGTERM")));
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error("Signal subscription failed"));
    }
  });
}
