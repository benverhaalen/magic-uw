/** Snapshot input before starting work. Invalidate on reset, route change or unmount.
 * Only the latest ticket may commit view state. This does not cancel external writes.
 */
export function createOperationScope() {
  let generation = 0;
  return {
    start() {
      const ticket = ++generation;
      return { isCurrent: () => ticket === generation };
    },
    invalidate() { generation++; },
  };
}
