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
  readonly registerRequestedStop?: (listener: () => void) => () => void;
  readonly onStarted?: () => void;
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
      for (const remove of unsubscribe.splice(0)) {
        try {
          remove();
        } catch {
          // Every registered stop source gets a best-effort removal attempt.
        }
      }
    };

    const stop = (reason: RuntimeSignal | "requested"): void => {
      if (stopPromise !== undefined) return;
      stopPromise = (async () => {
        const controller = new AbortController();
        let timer: NodeJS.Timeout | undefined;

        try {
          const timeoutPromise = new Promise<"forced">((resolveTimeout) => {
            timer = setTimeout(() => {
              controller.abort();
              resolveTimeout("forced");
            }, options.shutdownTimeoutMs);
          });
          options.stopAccepting();
          const drainPromise = options.drain(controller.signal);
          const drainOutcomePromise = drainPromise.then(
            () => ({ kind: "drained" as const }),
            (error: unknown) => ({ kind: "failed" as const, error }),
          );
          const outcome = await Promise.race([drainOutcomePromise, timeoutPromise]);
          if (outcome === "forced") {
            void drainPromise.catch(() => undefined);
          } else if (outcome.kind === "failed") {
            throw outcome.error;
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
      if (options.registerRequestedStop !== undefined) {
        unsubscribe.push(options.registerRequestedStop(() => stop("requested")));
      }
      if (stopPromise === undefined) options.onStarted?.();
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error("Signal subscription failed"));
    }
  });
}
