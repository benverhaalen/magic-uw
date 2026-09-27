import test from "node:test";
import assert from "node:assert/strict";
import { layoutLanes } from "@magic/domain";

const at = (id: string, startMin: number, endMin: number) => ({ id, startMin, endMin });
const lanes = (items: ReturnType<typeof at>[]) => Object.fromEntries(layoutLanes(items));

test("events that don't overlap each keep the full width", () => {
  assert.deepEqual(lanes([at("a", 540, 600), at("b", 600, 660)]), {
    a: { lane: 0, lanes: 1 },
    b: { lane: 0, lanes: 1 },
  });
});

test("two events at the same time sit side by side", () => {
  assert.deepEqual(lanes([at("lecture", 660, 710), at("office", 660, 720)]), {
    office: { lane: 0, lanes: 2 },
    lecture: { lane: 1, lanes: 2 },
  });
});

test("a chain of overlaps shares one column count, and a freed lane is reused", () => {
  // a 9-10, b 9:30-11, c 10-10:30 (reuses a's lane), d 12-1 (its own group).
  assert.deepEqual(lanes([at("c", 600, 630), at("a", 540, 600), at("d", 720, 780), at("b", 570, 660)]), {
    a: { lane: 0, lanes: 2 },
    b: { lane: 1, lanes: 2 },
    c: { lane: 0, lanes: 2 },
    d: { lane: 0, lanes: 1 },
  });
});

test("three events at once get three lanes", () => {
  const r = lanes([at("x", 600, 660), at("y", 610, 650), at("z", 620, 640)]);
  assert.deepEqual([r.x, r.y, r.z].map((v) => v!.lane).sort(), [0, 1, 2]);
  assert.ok([r.x, r.y, r.z].every((v) => v!.lanes === 3));
});
