/**
 * The action registry: every command-bar action the app can run, each with a zod schema over its
 * resolved arguments. The catalogue (name, description, argument names) is what the classify
 * pack sees; it is rendered deterministically so the prompt prefix stays byte-stable and caches.
 */
import { createHash } from "node:crypto";
import type { ActionSpec, ResolvedArgs } from "./types";

/** Specs narrow ResolvedArgs (a required course, say); `run` is a method, so they widen to this. */
export type AnyAction = ActionSpec<ResolvedArgs>;

export interface ActionRegistry {
  register(spec: AnyAction): void;
  get(name: string): AnyAction | undefined;
  list(): AnyAction[];
  /** One line per action, in registration order; byte-stable for the same registry. */
  catalogue(): string;
  catalogueHash(): string;
}

export function createRegistry(specs: AnyAction[] = []): ActionRegistry {
  const byName = new Map<string, AnyAction>();
  const register = (spec: AnyAction) => {
    if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/.test(spec.name)) throw new Error(`Action name ${spec.name} must be dotted lower case.`);
    if (byName.has(spec.name)) throw new Error(`Action ${spec.name} is already registered.`);
    byName.set(spec.name, spec);
  };
  for (const s of specs) register(s);
  const catalogue = () =>
    [...byName.values()]
      .map((s) => {
        const args = Object.entries(s.slots)
          .map(([k, v]) => (v === "required" ? k : `${k}?`))
          .join(", ");
        const example = s.examples[0] ? ` e.g. ${JSON.stringify(s.examples[0])}` : "";
        return `- ${s.name}(${args}): ${s.description}${example}`;
      })
      .join("\n");
  return {
    register,
    get: (name) => byName.get(name),
    list: () => [...byName.values()],
    catalogue,
    catalogueHash: () => createHash("sha256").update(catalogue()).digest("hex"),
  };
}

export type { ActionSpec, ResolvedArgs };
