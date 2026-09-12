export type ApplicationShutdownReason = 'app_quit' | 'update' | 'fatal';
export interface ApplicationShutdownTarget { shutdown(reason: ApplicationShutdownReason): Promise<void>; }

/** Frozen task managers retain fenced records after shutdown. Only a full consumer join retires their busy predicate. */
export function createResourceConsumerLifecycle(options: ApplicationShutdownTarget & { isResourceBusy(resourceId: string): boolean }) {
  let joined = false;
  let operation: Promise<void> | undefined;
  return {
    isResourceBusy: (resourceId: string) => !joined && options.isResourceBusy(resourceId),
    shutdown(reason: ApplicationShutdownReason): Promise<void> {
      if (operation) return operation;
      operation = Promise.resolve().then(() => options.shutdown(reason)).then(() => { joined = true; })
        .catch(error => { operation = undefined; throw error; });
      return operation;
    },
  };
}

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

/** Shared resources outlive every consumer; a failed consumer join retains that ordering on retry. */
export function createSharedResourceApplicationShutdown(options: {
  resources: ApplicationShutdownTarget & { fence(): void };
  runtimes: readonly ApplicationShutdownTarget[];
  smokeServer: ApplicationShutdownTarget;
}): ApplicationShutdownTarget {
  const consumers = createApplicationShutdown(options.runtimes);
  const smoke = createApplicationShutdown([options.smokeServer]);
  const resources = createApplicationShutdown([options.resources]);
  let operation: Promise<void> | undefined;
  return {
    shutdown(reason) {
      if (operation) return operation;
      let fenceError: unknown;
      operation = Promise.resolve().then(async () => {
        await consumers.shutdown(reason);
        await smoke.shutdown(reason);
        await resources.shutdown(reason);
        if (fenceError !== undefined) throw fenceError;
      }).catch(error => { operation = undefined; throw error; });
      // Publish the join before cancellation callbacks can synchronously re-enter.
      try { options.resources.fence(); } catch (error) { fenceError = error; }
      return operation;
    },
  };
}
