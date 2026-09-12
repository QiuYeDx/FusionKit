export type ApplicationShutdownReason = 'app_quit' | 'update' | 'fatal';
export interface ApplicationShutdownTarget { shutdown(reason: ApplicationShutdownReason): Promise<void>; }

/** One terminal attempt reaches every independent runtime, including after sibling failure. */
export function createApplicationShutdown(targets: readonly ApplicationShutdownTarget[]): ApplicationShutdownTarget {
  const remaining = new Set(targets);
  let operation: Promise<void> | undefined;
  return {
    shutdown(reason) {
      if (operation) return operation;
      // Cache before invoking targets: abort listeners may synchronously reenter shutdown.
      operation = Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        const results = await Promise.allSettled([...remaining].map(async target => {
          await target.shutdown(reason); remaining.delete(target);
        }));
        for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
        if (failures.length) throw new AggregateError(failures, 'Application runtime cleanup failed.');
      }).catch(error => { operation = undefined; throw error; });
      return operation;
    },
  };
}
