// owner: study-prep. The student's correction of an item's type: kept with the course's type
// records, it wins over code and their AI from then on.
import type { Correction, Store } from "@magic/contracts";
import { ITEM_SPACE } from "@magic/contracts";
import { writeTypes } from "./item-type";
import { courseScope, isPrepStore } from "./scope";

export function correctItemType(store: Store, value: Extract<Correction, { subject: "item_type" }>, at: string): string {
  if (!isPrepStore(store)) return "Item types need the workspace's learning store; nothing was changed.";
  const accountScope = courseScope(store, value.courseId);
  if (!accountScope) return "That course isn't saved; nothing was changed.";
  writeTypes(store.learning, `${accountScope}:${value.courseId}`, { [value.itemId]: { type: value.type, reason: "You set this", basis: "student", at } }, at);
  return `Saved: this is a ${ITEM_SPACE[value.type].label.toLowerCase()}.`;
}
