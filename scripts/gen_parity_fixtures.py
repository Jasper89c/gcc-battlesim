"""Generate test/fixtures.json: battles resolved by the GCR backend's Python sim, for
test/parity.test.ts to replay through the TypeScript port and compare.

Run from the GCR repo root with the backend's virtualenv, after any change to
backend/app/sims/combat.py or engine.py (and after re-running export_ships.py):
    backend/.venv/Scripts/python battlesim-pages/scripts/gen_parity_fixtures.py [cases]

Flanking picks a random target, so both sides swap their RNG for the same deterministic
picker (the k-th pick of a battle takes targets[k % len(targets)]) — that makes every
battle exactly reproducible, including the ones with unequal stack counts.
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT.parent / "backend"))

from app.api import sims as sims_api  # noqa: E402
from app.schemas import BattleSimRequest  # noqa: E402
from app.sims import combat, engine  # noqa: E402

SHIPS = json.loads((ROOT / "src" / "ships.json").read_text(encoding="utf-8"))
BY_ID = {s["id"]: SimpleNamespace(**s) for s in SHIPS}


class CatalogDb:
    """Stands in for the SQLAlchemy session: the sim only ever calls db.get(model, id)."""

    def get(self, _model, ship_type_id):
        return BY_ID.get(ship_type_id)


class CyclingPicker:
    def __init__(self):
        self.k = 0

    def choice(self, items):
        picked = items[self.k % len(items)]
        self.k += 1
        return picked


# resolve_battle() falls back to random.Random() when no rng is passed, which is how
# simulate_battle_sim calls it.
combat.random = SimpleNamespace(Random=CyclingPicker)

RACES = ["Terran", "Aspha Miner", "Guardian", "Marauder", "Viral", "Collective",
         "Kal-Zul", "D.Marauder", "Event", "Bastion"]


def random_side(rng: random.Random, race: str, power_budget: float) -> dict:
    pool = [s for s in SHIPS if s["race"] in engine.allowed_ship_races(race)]
    ships = []
    for ship in rng.sample(pool, min(len(pool), rng.randint(1, 10))):
        # Mostly fleet-sized stacks, with the odd tiny one (1-3 ships) to exercise the
        # whole-ship truncation and the "stack of 1 isn't scaled" rule.
        if rng.random() < 0.15:
            count = rng.randint(1, 3)
        else:
            count = max(1, round(power_budget * rng.uniform(0.02, 1.0) / max(1, ship["power"])))
        ships.append({"ship_type_id": ship["id"], "count": min(count, 100_000_000)})
    return {"race": race, "ships": ships}


def main() -> None:
    cases_wanted = int(sys.argv[1]) if len(sys.argv) > 1 else 150
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "test" / "fixtures.json"
    rng = random.Random(20261001)
    cases = []
    while len(cases) < cases_wanted:
        budget = 10 ** rng.uniform(3, 9)
        request = {
            "attacker": random_side(rng, rng.choice(RACES), budget * rng.uniform(0.5, 2.0)),
            "defender": random_side(rng, rng.choice(RACES), budget),
            "attitude": rng.choice(["careful", "normal", "aggressive"]),
            "enslave": rng.random() < 0.3,
        }
        if rng.random() < 0.3:
            request["attacker_power_rating"] = rng.choice([75, 100, 130, 150, rng.randint(1, 1000)])
        body = BattleSimRequest(**request)
        result = sims_api._run_battle_sim(body, CatalogDb())
        report = sims_api._battle_sim_report(body, result)
        cases.append({"request": request, "report": report.model_dump()})
    out_path.write_text(
        "[\n" + ",\n".join(json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in cases) + "\n]\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(cases)} cases to {out_path}")


if __name__ == "__main__":
    main()
