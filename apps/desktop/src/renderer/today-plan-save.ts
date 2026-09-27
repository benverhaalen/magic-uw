import type { Command } from "@magic/contracts";

/** App.run may resolve undefined after a blocked or failed operation. That is not a save. */
export async function requirePlanSave<T>(run: (command: Command) => Promise<T>, command: Command): Promise<NonNullable<T>> {
  const result = await run(command);
  if (result == null || result === false) throw new Error("Plan change was not saved");
  return result as NonNullable<T>;
}
