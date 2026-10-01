"""Export the Battle Sim's ship catalog from the GCR backend database to src/ships.json.

Run from the GCR repo root whenever sim ship stats change:
    python battlesim-pages/scripts/export_ships.py [path/to/gcr.db]

Only the fields the Battle Sim reads are kept (see ShipType in src/combat.ts), ordered by
power to match the backend's /sims/reference/ships listing.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

FIELDS = (
    "id", "race", "name", "ship_class", "energy", "kinetic", "missile", "chemical",
    "hull", "ship_range", "power", "specials", "defense_modifiers",
)
JSON_FIELDS = {"specials", "defense_modifiers"}

db_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("backend/gcr.db")
out_path = Path(__file__).resolve().parent.parent / "src" / "ships.json"

db = sqlite3.connect(db_path)
db.row_factory = sqlite3.Row
rows = db.execute(f"SELECT {', '.join(FIELDS)} FROM sim_ship_types ORDER BY power, id").fetchall()
ships = [
    {f: (json.loads(r[f] or "[]") if f in JSON_FIELDS else r[f]) for f in FIELDS}
    for r in rows
]
out_path.write_text(
    "[\n" + ",\n".join("  " + json.dumps(s, ensure_ascii=False) for s in ships) + "\n]\n",
    encoding="utf-8",
)
print(f"Wrote {len(ships)} ships to {out_path}")
