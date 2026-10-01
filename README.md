# GCC Battle Sim (standalone)

The Battle Sim from gcc.jasperlabs.uk/battlesim as a static page. Everything runs in the
browser: the combat maths is a TypeScript port of the GCR backend's Python sim, and the ship
catalog is bundled into the page. There is no server and no API.

The build is one self-contained file, `docs/index.html`, which is committed so GitHub Pages
can serve it without a build step.

## Publish on GitHub Pages

1. Push this folder as its own repository (it must be the repository root so `docs/` sits
   at the top level).
2. In the repository's **Settings → Pages**, set **Source** to "Deploy from a branch", pick
   `main` and the `/docs` folder, and save.
3. The page appears at `https://<user>.github.io/<repo>/` a minute or so later.

Pages on a private repository needs a paid GitHub plan; a public repository works on any.

## Layout

| Path | What it is |
|---|---|
| `src/combat.ts` | Battle resolution — port of `backend/app/sims/combat.py` |
| `src/engine.ts` | Fleet building, power-rating scaling, 1000-run batch, report — port of the battle parts of `backend/app/sims/engine.py` and `backend/app/api/sims.py` |
| `src/BattleSimPage.tsx` | The page — `frontend/src/pages/BattleSimPage.tsx` with the API calls replaced |
| `src/ships.json` | Ship catalog exported from the `sim_ship_types` table |
| `src/styles.css` | The subset of the site's stylesheet this page uses |
| `test/` | Battles recorded from the Python sim, replayed through the TypeScript one |
| `docs/index.html` | The built page |

## Develop

```
npm install
npm run dev      # local preview with hot reload
npm test         # TypeScript sim vs recorded Python results
npm run build    # rebuild docs/index.html
```

## Keeping it in step with the GCR backend

This is a second copy of the sim, so a change on the Python side has to be repeated here.
Both scripts run from the GCR repository root.

**Ship stats changed** (a row in `sim_ship_types` was added or edited):

```
python battlesim-pages/scripts/export_ships.py            # reads backend/gcr.db
backend/.venv/Scripts/python battlesim-pages/scripts/gen_parity_fixtures.py
```

The export reads the local database, so it must hold the same sim ship data as the live
one. Pass another database path as the first argument to export from a copy.

**Combat rules changed** (`backend/app/sims/combat.py` or `engine.py`): make the same change
in `src/combat.ts` / `src/engine.ts`, then regenerate the fixtures with the second command
above.

Either way, finish with `npm test` and `npm run build`, then commit `docs/index.html`.
