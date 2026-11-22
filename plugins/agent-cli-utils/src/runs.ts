export interface RunRegistry {
  begin(runId: string, hostSignal: AbortSignal): AbortSignal;
  end(runId: string): void;
  cancel(runId: string): void;
}

export function createRunRegistry(): RunRegistry {
  const runs = new Map<string, { controller: AbortController; detach: () => void }>();
  return {
    begin(runId, hostSignal) {
      const controller = new AbortController();
      const onHostAbort = () => controller.abort();
      if (hostSignal.aborted) {
        controller.abort();
      } else {
        hostSignal.addEventListener("abort", onHostAbort, { once: true });
      }
      runs.set(runId, {
        controller,
        detach: () => hostSignal.removeEventListener("abort", onHostAbort),
      });
      return controller.signal;
    },
    end(runId) {
      runs.get(runId)?.detach();
      runs.delete(runId);
    },
    cancel(runId) {
      runs.get(runId)?.controller.abort();
    },
  };
}