// Replays battles resolved by the GCR backend's Python sim (test/fixtures.json, written by
// scripts/gen_parity_fixtures.py) through the TypeScript port and expects the same report.
//
//   npm test                  — the committed fixtures
//   node --test test/ -- ...  — or point PARITY_FIXTURES at a bigger generated file

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Choice } from "../src/combat.ts";
import {
  battleSimReport, simulateBattleSim,
  type BattleSimReport, type BattleSimRequest, type ShipType,
} from "../src/engine.ts";

const read = (path: string | URL) => JSON.parse(readFileSync(path, "utf-8"));
const ships: ShipType[] = read(new URL("../src/ships.json", import.meta.url));
const cases: { request: BattleSimRequest; report: BattleSimReport }[] =
  read(process.env.PARITY_FIXTURES ?? new URL("./fixtures.json", import.meta.url));
const shipsById = new Map(ships.map((s) => [s.id, s]));

// The fixtures were generated with this same picker in place of the RNG: the k-th flanking
// pick of a battle takes targets[k % targets.length].
function cyclingPicker(): Choice {
  let k = 0;
  return (items) => items[k++ % items.length];
}

// The two percentages are rounded to 4 places on each side with slightly different
// rounding routines, so allow them to land one step apart; everything else must be exact.
const PCT_FIELDS = ["defender_kill_pct", "attacker_loss_pct"] as const;

test(`TypeScript sim matches the Python sim on ${cases.length} recorded battles`, () => {
  assert.ok(cases.length > 0);
  cases.forEach(({ request, report: expected }, i) => {
    const fought = simulateBattleSim(shipsById, request, cyclingPicker());
    const actual = battleSimReport(request, fought);
    for (const f of PCT_FIELDS) {
      assert.ok(Math.abs(actual[f] - expected[f]) <= 1.0001e-4, `case ${i}: ${f} ${actual[f]} vs ${expected[f]}`);
    }
    const strip = (r: BattleSimReport) => ({ ...r, defender_kill_pct: 0, attacker_loss_pct: 0 });
    assert.deepEqual(strip(actual), strip(expected), `case ${i}`);
  });
});

test("flanking fights are covered by the fixtures", () => {
  const uneven = cases.filter((c) => c.request.attacker.ships.length !== c.request.defender.ships.length);
  assert.ok(uneven.length >= cases.length / 2);
});
