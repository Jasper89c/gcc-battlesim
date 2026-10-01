import { useEffect, useMemo, useState } from "react";
import {
  battleSimBatch, EVENT_RACE, EVENT_SOURCE_RACES, FOREIGN_HULL_RACES, FOREIGN_HULL_SOURCE_RACES,
  RACES, shipsForRace, SimError,
  type BattleFleetEntry, type BattleSimBatchReport, type ShipType, type SimShipEntry,
} from "./engine.ts";
import shipCatalog from "./ships.json";

// The whole sim runs in the browser: the ship catalog is bundled with the page (see
// scripts/export_ships.py) and battles are resolved by engine.ts/combat.ts.
const ALL_SHIPS: ShipType[] = shipCatalog;
const SHIPS_BY_ID = new Map(ALL_SHIPS.map((s) => [s.id, s]));

const full = (n: number) => Math.round(n).toLocaleString("en-US");

const ROWS = 10;
const ATTITUDES = ["careful", "normal", "aggressive"] as const;
type PasteMode = "attacker" | "both" | "defender";

// Default guess when a fleet's hull mix alone proves it's a foreign-hull race (Viral
// reverse-engineers foreign ships, Collective keeps what it captures) but no native
// Viral/Collective ship name says which one (see matchAgainstCatalog).
const REVERSE_ENGINEER_RACE = "Viral";
// Kept selectable in the matching logic below (pasted fleets still resolve to these races),
// but hidden from the race dropdown itself — not meant to be manually browsable/selectable.
const HIDDEN_DROPDOWN_RACES = new Set([EVENT_RACE, "Bastion"]);
const VISIBLE_RACES = RACES.filter((r) => !HIDDEN_DROPDOWN_RACES.has(r));

interface ShipRow {
  shipTypeId: string;
  count: string;
}

interface ParsedShipLine {
  name: string;
  units: number;
  remaining: number;
}

type PasteField = "units" | "remaining";

const emptyRows = (): ShipRow[] => Array.from({ length: ROWS }, () => ({ shipTypeId: "", count: "" }));

// One pasted line is either an empire-name divider (no Units column) or a ship row
// "Name  Units  Casualties  Remaining" (only Name/Units are used). In-game reports are
// plain text with columns aligned by runs of spaces rather than real tabs, so both are
// accepted as column separators — a single space is left alone since ship names/classes
// contain single spaces (e.g. "Angel Battleship").
function lineCols(raw: string): string[] {
  return raw.trim().split(/\t+|[ ]{2,}/).map((c) => c.trim()).filter((c) => c !== "");
}

function parseShipLine(cols: string[]): ParsedShipLine | null {
  if (cols.length < 2 || /^(name|total)$/i.test(cols[0])) return null;
  const units = Number(cols[1].replace(/,/g, ""));
  if (!Number.isFinite(units) || units <= 0) return null;
  // Remaining is the 4th column (Name/Units/Casualties/Remaining); when it's absent
  // (a plain Name/Units paste) fall back to Units so "Remaining" still has something to use.
  const remainingRaw = cols.length >= 4 ? Number(cols[3].replace(/,/g, "")) : NaN;
  const remaining = Number.isFinite(remainingRaw) ? remainingRaw : units;
  return { name: cols[0], units, remaining };
}

/** The "Manage Fleet" style page shows each ship as a multi-line block instead of a single
 * row:
 *   Name<TAB>Class<TAB>10%<TAB>50%<TAB>All<TAB>-     (quick-select buttons; the trailing
 *                                                      Disband input copies as "-", or as
 *                                                      nothing at all if it's empty)
 *   +
 *                                                     (blank — "+"/blank lines are optional;
 *                                                      some copies paste the data line right
 *                                                      after the header with no gap)
 *   InFleet<TAB>TotalUpkeep<TAB>PowerPerUnit<TAB>TotalPower
 * Some browsers copy the same table as one line per ship instead, with the numbers trailing
 * the quick-select columns on the same row:
 *   Name<TAB>Class<TAB>10%<TAB>50%<TAB>All<TAB>[Disband]<TAB>InFleet<TAB>TotalUpkeep<TAB>...
 * A compact variant of the table drops the quick-select columns entirely:
 *   Name<TAB>Class<TAB>[Disband]<TAB>InFleet<TAB>TotalUpkeep<TAB>PowerPerUnit<TAB>TotalPower
 * That one is recognised by a non-numeric Class column followed by exactly four numeric
 * columns (after an optional "-" Disband) — battle-report rows with a split name never have
 * more than three trailing numbers, so they can't match.
 * Collapse either shape into one "Name Class<TAB>InFleet" line — the same shape the rest
 * of the pipeline already expects — so parseShipLine/resolveCandidates handle it unchanged.
 * The block header is recognised by its "10%<TAB>50%<TAB>All" quick-select signature (stable
 * regardless of whether the Disband column trails it) rather than that trailing column, since
 * an empty Disband input copies as nothing rather than "-"; the data columns are recognised
 * by every one being numeric, whether they trail on the same line or sit on the next line.
 */
const allNumeric = (cols: string[]) =>
  cols.length > 0 && cols.every((c) => Number.isFinite(Number(c.replace(/,/g, ""))));

function collapseManageFleetBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = lineCols(lines[i]);
    const isHeader = cols.length >= 5 && cols[2] === "10%" && cols[3] === "50%"
      && /^all$/i.test(cols[4]) && !/^name$/i.test(cols[0]);
    if (!isHeader) {
      const compact = cols[2] === "-" ? cols.slice(3) : cols.slice(2);
      if (cols.length >= 3 && !/^name$/i.test(cols[0]) && !allNumeric([cols[1]])
          && compact.length === 4 && allNumeric(compact)) {
        out.push(`${cols[0]} ${cols[1]}\t${compact[0]}`);
        continue;
      }
      out.push(lines[i]);
      continue;
    }

    // Single-line variant: the numeric columns trail "All" (after an optional "-" Disband)
    // on the same row, so no lookahead is needed.
    const trailing = cols[5] === "-" ? cols.slice(6) : cols.slice(5);
    if (allNumeric(trailing)) {
      out.push(`${cols[0]} ${cols[1]}\t${trailing[0]}`);
      continue;
    }

    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "+") j++;
    while (j < lines.length && lines[j].trim() === "") j++;
    const dataCols = j < lines.length ? lineCols(lines[j]) : [];
    if (!allNumeric(dataCols)) { out.push(lines[i]); continue; }

    out.push(`${cols[0]} ${cols[1]}\t${dataCols[0]}`);
    i = j;
  }
  return out.join("\n");
}

/** The mobile/vertical "Manage Fleet" layout copies each ship as a run of lines:
 *   Name
 *   - Class
 *   Range - 6
 *   Rate - 10.0
 *   -  +  (adjustment buttons, one per line; some copies also include +5 +10 ↑ ↑↑)
 *   Owned: 1
 *   Pwr: 5,881
 *   PR: 5,881
 * A block is recognised by a "- Class" line directly under a name line with an "Owned: N"
 * line further down (before the next ship's "- Class" line), and collapses to
 * "Name Class<TAB>Owned" — the standalone "-" button line can't be mistaken for a class
 * line since it has nothing after the dash. Ships with Owned: 0 still collapse; the zero
 * count gets them dropped later by parseShipLine like any other empty row. */
function collapseVerticalFleetBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const name = lines[i].trim();
    const cls = i + 1 < lines.length ? lines[i + 1].trim().match(/^-\s+(\S.*)$/) : null;
    let owned: string | null = null;
    let j = i + 2;
    if (name && cls) {
      for (; j < lines.length; j++) {
        const t = lines[j].trim();
        const m = t.match(/^owned:\s*([\d,]+)$/i);
        if (m) { owned = m[1]; break; }
        if (/^-\s+\S/.test(t)) break;
      }
    }
    if (owned === null) { out.push(lines[i]); i++; continue; }
    out.push(`${name} ${cls![1]}\t${owned}`);
    i = j + 1;
    while (i < lines.length && /^(pwr|pr):/i.test(lines[i].trim())) i++;
  }
  return out.join("\n");
}

const collapseFleetPaste = (text: string) =>
  collapseManageFleetBlocks(collapseVerticalFleetBlocks(text));

/** Single fleet: every ship row counts, empire-name divider lines are just ignored. */
function parseFleetLines(text: string): ParsedShipLine[] {
  const out: ParsedShipLine[] = [];
  for (const raw of collapseFleetPaste(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const parsed = parseShipLine(lineCols(raw));
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Both fleets: an empire-name divider line (no Units column) starts a new group. The
 * first two non-empty groups become the attacker and defender fleets. */
function splitFleetLines(text: string): [ParsedShipLine[], ParsedShipLine[]] | null {
  const groups: ParsedShipLine[][] = [];
  let current: ParsedShipLine[] | null = null;
  for (const raw of collapseFleetPaste(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cols = lineCols(raw);
    if (cols.length < 2) {
      current = [];
      groups.push(current);
      continue;
    }
    const parsed = parseShipLine(cols);
    if (!parsed) continue;
    if (!current) { current = []; groups.push(current); }
    current.push(parsed);
  }
  const nonEmpty = groups.filter((g) => g.length > 0);
  return nonEmpty.length < 2 ? null : [nonEmpty[0], nonEmpty[1]];
}

interface MatchResult {
  matched: { id: number; units: number; remaining: number; race: string; power: number }[];
  unmatched: string[];
  race: string | null;
}

/** In-game fleet reports show "<ShipName> <Class>" as one label (e.g. "Angel Battleship")
 * for most ships, but a handful of catalog names already include what looks like a class
 * word (e.g. "Small Strafez Runner", "Light fighter-drone") and are shown as-is with no
 * suffix. Try an exact match first, then fall back to stripping the trailing word and
 * matching it against that candidate's ship_class. */
function resolveCandidates(name: string, byName: Map<string, ShipType[]>): ShipType[] | undefined {
  const direct = byName.get(name.toLowerCase());
  if (direct) return direct;
  const idx = name.lastIndexOf(" ");
  if (idx <= 0) return undefined;
  const base = byName.get(name.slice(0, idx).toLowerCase());
  if (!base) return undefined;
  const cls = name.slice(idx + 1).toLowerCase();
  const withClass = base.filter((c) => c.ship_class.toLowerCase() === cls);
  return withClass.length ? withClass : undefined;
}

/** Matches pasted ship names against the full catalog (case-insensitive). Some ship names
 * are reused across races (e.g. Kal-Zul mirrors every other race's hulls) — those don't
 * count as evidence for a race on their own, only names unique to one race do. If any
 * unambiguous name resolves to Viral or Collective, the fleet defaults to that race: both
 * can crew foreign hulls from Terran/Aspha Miner/Marauder (reverse engineering / captures),
 * so a fleet showing e.g. Viral + Terran ships together is a normal Viral fleet, not an
 * error. A fleet spanning two or more of Terran/Aspha Miner/Marauder is the same signal even
 * without a native Viral/Collective ship name present — a real Terran (etc.) empire can never
 * own another source race's hull, so that split can only mean a foreign-hull race; Viral is
 * the default guess since Collective can't be told apart from the hull mix alone. Likewise,
 * any unambiguous Event name defaults the fleet to Event even alongside Guardian ships, since
 * Event fields real Guardian hulls the same way. Without either signal, multiple distinct
 * races just picks whichever is most common (paste noise/mismatches, not a real mixed-race
 * fleet). */
function matchAgainstCatalog(parsed: ParsedShipLine[], catalog: ShipType[]): MatchResult {
  const byName = new Map<string, ShipType[]>();
  for (const s of catalog) {
    const key = s.name.toLowerCase();
    const arr = byName.get(key);
    if (arr) arr.push(s); else byName.set(key, [s]);
  }

  const raceCounts = new Map<string, number>();
  for (const p of parsed) {
    const candidates = resolveCandidates(p.name, byName);
    if (!candidates) continue;
    const nonNeutral = candidates.filter((c) => c.race !== "Neutral");
    if (nonNeutral.length === 1) {
      raceCounts.set(nonNeutral[0].race, (raceCounts.get(nonNeutral[0].race) ?? 0) + 1);
    }
  }
  const raceKeys = [...raceCounts.keys()];
  const foreignHullRace = raceKeys.find((r) => FOREIGN_HULL_RACES.has(r))
    ?? (raceKeys.includes(EVENT_RACE) ? EVENT_RACE : undefined)
    ?? (raceKeys.filter((r) => FOREIGN_HULL_SOURCE_RACES.has(r)).length >= 2 ? REVERSE_ENGINEER_RACE : undefined);
  let race: string | null = foreignHullRace ?? null;
  if (!race) {
    let best = 0;
    for (const [r, n] of raceCounts) {
      if (n > best) { best = n; race = r; }
    }
  }

  const matched: MatchResult["matched"] = [];
  const unmatched: string[] = [];
  for (const p of parsed) {
    const candidates = resolveCandidates(p.name, byName);
    if (!candidates) { unmatched.push(p.name); continue; }
    const chosen = (race ? candidates.find((c) => c.race === race) : undefined)
      ?? (race && FOREIGN_HULL_RACES.has(race)
        ? candidates.find((c) => FOREIGN_HULL_SOURCE_RACES.has(c.race)) : undefined)
      ?? (race === EVENT_RACE ? candidates.find((c) => EVENT_SOURCE_RACES.has(c.race)) : undefined)
      ?? candidates.find((c) => c.race === "Neutral")
      ?? candidates[0];
    matched.push({ id: chosen.id, units: p.units, remaining: p.remaining, race: chosen.race, power: chosen.power });
  }
  if (!race && matched.length) race = matched.find((m) => m.race !== "Neutral")?.race ?? matched[0].race;
  return { matched, unmatched, race };
}

// Rows with a zero count for the chosen field (e.g. a stack wiped out, so Remaining is 0)
// are dropped rather than taking up one of the limited row slots with a useless 0. The
// strongest stacks are kept when a fleet has more than ROWS distinct ships, so sort by
// total power (power * count) descending before truncating.
function rowsFromMatched(
  matched: MatchResult["matched"], field: PasteField,
): { rows: ShipRow[]; truncated: boolean; applied: number } {
  const usable = matched
    .filter((m) => m[field] > 0)
    .sort((a, b) => b.power * b[field] - a.power * a[field]);
  const rows = emptyRows();
  usable.slice(0, ROWS).forEach((m, i) => { rows[i] = { shipTypeId: String(m.id), count: String(m[field]) }; });
  return { rows, truncated: usable.length > ROWS, applied: usable.length };
}

function summarize(label: string, m: MatchResult, field: PasteField, applied: number, truncated: boolean): string {
  if (m.matched.length === 0) return `${label}: no ships matched the catalog.`;
  const fieldLabel = field === "units" ? "Units" : "Remaining";
  if (applied === 0) return `${label}: matched ${m.matched.length} ship name(s), but none have ${fieldLabel} > 0.`;
  const parts = [`${label}: applied ${applied} ship row(s) from ${fieldLabel}${m.race ? ` — detected ${m.race}` : ""}.`];
  if (truncated) parts.push(`Only the first ${ROWS} rows are used (max ${ROWS} stacks fight anyway).`);
  if (m.unmatched.length) parts.push(`Unmatched: ${m.unmatched.join(", ")}.`);
  return parts.join(" ");
}

// Sorts rows by total power (power * count) descending, empty rows last. Returns the same
// array reference when the order is already correct, so React bails out of the update —
// needed so the debounced re-sort effect below doesn't reschedule itself forever.
function sortRowsByPower(rows: ShipRow[], allShips: ShipType[]): ShipRow[] {
  const powerById = new Map(allShips.map((s) => [s.id, s.power]));
  const scored = rows.map((row) => {
    if (!row.shipTypeId) return { row, score: -1 };
    const power = powerById.get(Number(row.shipTypeId)) ?? 0;
    const count = Number(row.count);
    return { row, score: power * (Number.isFinite(count) ? count : 0) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.every(({ row }, i) => row === rows[i]) ? rows : scored.map(({ row }) => row);
}

function SideEditor({
  title, races, race, onRace, ships, allShips, rows, onRow, onSettle,
}: {
  title: string;
  races: string[];
  race: string;
  onRace: (r: string) => void;
  ships: ShipType[];
  allShips: ShipType[];
  rows: ShipRow[];
  onRow: (i: number, row: ShipRow) => void;
  onSettle: () => void;
}) {
  // Looked up from the full catalog (not the race-filtered `ships` list) so a row's power
  // still resolves correctly right after a paste sets a shipTypeId before the race-filtered
  // dropdown list has caught up.
  const powerById = new Map(allShips.map((s) => [s.id, s.power]));

  // Scratch input for the "Add by Power" column — a power budget the user types in, consumed
  // (and cleared) on blur to add floor(budget / unitPower) units to that row's existing count.
  const [budgetInputs, setBudgetInputs] = useState<string[]>(() => rows.map(() => ""));
  const applyBudget = (i: number) => {
    const row = rows[i];
    const power = row.shipTypeId ? powerById.get(Number(row.shipTypeId)) ?? 0 : 0;
    const budget = Number(budgetInputs[i]);
    if (power > 0 && Number.isFinite(budget) && budget > 0) {
      const add = Math.floor(budget / power);
      if (add > 0) {
        const existing = Number(row.count);
        onRow(i, { ...row, count: String((Number.isFinite(existing) ? existing : 0) + add) });
      }
    }
    setBudgetInputs((b) => b.map((v, idx) => (idx === i ? "" : v)));
    onSettle();
  };

  const fleetPower = rows.reduce((sum, row) => {
    const power = row.shipTypeId ? powerById.get(Number(row.shipTypeId)) ?? 0 : 0;
    const count = Number(row.count);
    return sum + power * (Number.isFinite(count) ? count : 0);
  }, 0);

  return (
    <section className="panel">
      <div className="panel-title">{title}</div>
      <div className="market-field">
        <span className="market-field__label">Race</span>
        <select value={race} onChange={(e) => onRace(e.target.value)}>
          {races.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <table className="colony-table">
        <thead>
          <tr>
            <th>Ship</th><th className="num">Count</th><th className="num">Total Power</th>
            <th className="num">Add by Power</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const power = row.shipTypeId ? powerById.get(Number(row.shipTypeId)) ?? 0 : 0;
            const count = Number(row.count);
            const totalPower = power * (Number.isFinite(count) ? count : 0);
            return (
              <tr key={i}>
                <td>
                  <select
                    value={row.shipTypeId} onBlur={onSettle}
                    onChange={(e) => onRow(i, { ...row, shipTypeId: e.target.value })}
                  >
                    <option value="">—</option>
                    {ships.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </td>
                <td className="num">
                  <input
                    type="number" min={0} value={row.count} disabled={!row.shipTypeId} onBlur={onSettle}
                    onChange={(e) => onRow(i, { ...row, count: e.target.value })}
                    style={{ width: 120 }}
                  />
                </td>
                <td className="num">{row.shipTypeId ? full(totalPower) : "—"}</td>
                <td className="num">
                  <input
                    type="number" min={0} value={budgetInputs[i] ?? ""} disabled={!row.shipTypeId}
                    onBlur={() => applyBudget(i)}
                    onChange={(e) => setBudgetInputs((b) => b.map((v, idx) => (idx === i ? e.target.value : v)))}
                    style={{ width: 120 }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td style={{ fontWeight: 600 }}>Total Power Rating</td>
            <td />
            <td className="num" style={{ fontWeight: 600 }}>{full(fleetPower)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

function TopBar({ title }: { title: string }) {
  return (
    <header className="topbar topbar--standalone toolsbar">
      <span className="topbar-brand toolsbar__brand">GCC</span>
      <span className="toolsbar__title">{title}</span>
    </header>
  );
}

export default function BattleSimPage() {
  const races = VISIBLE_RACES;
  const allShips = ALL_SHIPS;
  const [attackerRace, setAttackerRace] = useState(VISIBLE_RACES[0]);
  const [defenderRace, setDefenderRace] = useState(VISIBLE_RACES[0]);
  // Only the dropdown's ship list follows the race — rows are NOT reset here, so a paste can
  // set the race and the rows together without the rows being clobbered back to empty.
  const attackerShips = useMemo(() => shipsForRace(allShips, attackerRace), [allShips, attackerRace]);
  const defenderShips = useMemo(() => shipsForRace(allShips, defenderRace), [allShips, defenderRace]);
  const [attackerRows, setAttackerRows] = useState<ShipRow[]>(emptyRows());
  const [defenderRows, setDefenderRows] = useState<ShipRow[]>(emptyRows());
  const [attitude, setAttitude] = useState<string>("normal");
  const [enslave, setEnslave] = useState(false);
  const [attackerPowerRating, setAttackerPowerRating] = useState<number | null>(null);
  const [report, setReport] = useState<BattleSimBatchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pasteMode, setPasteMode] = useState<PasteMode | null>(null);
  const [pasteText, setPasteText] = useState("");

  // Manual edits re-sort by total power 2s after the last change, or immediately on blur
  // (see SideEditor's onSettle) — whichever comes first. sortRowsByPower returns the same
  // array reference when nothing needs to move, so an already-sorted table doesn't keep
  // rescheduling this timer forever.
  useEffect(() => {
    const t = setTimeout(() => setAttackerRows((rs) => sortRowsByPower(rs, allShips)), 2000);
    return () => clearTimeout(t);
  }, [attackerRows, allShips]);
  useEffect(() => {
    const t = setTimeout(() => setDefenderRows((rs) => sortRowsByPower(rs, allShips)), 2000);
    return () => clearTimeout(t);
  }, [defenderRows, allShips]);

  const onAttackerRace = (r: string) => { setAttackerRace(r); setAttackerRows(emptyRows()); };
  const onDefenderRace = (r: string) => { setDefenderRace(r); setDefenderRows(emptyRows()); };
  const updateAttackerRow = (i: number, row: ShipRow) =>
    setAttackerRows((rs) => rs.map((r, idx) => (idx === i ? row : r)));
  const updateDefenderRow = (i: number, row: ShipRow) =>
    setDefenderRows((rs) => rs.map((r, idx) => (idx === i ? row : r)));
  const settleAttackerRows = () => setAttackerRows((rs) => sortRowsByPower(rs, allShips));
  const settleDefenderRows = () => setDefenderRows((rs) => sortRowsByPower(rs, allShips));

  const swapFleets = () => {
    setAttackerRace(defenderRace);
    setDefenderRace(attackerRace);
    setAttackerRows(defenderRows);
    setDefenderRows(attackerRows);
  };

  const togglePaste = (mode: PasteMode) => {
    setError(null); setNotice(null); setPasteText("");
    setPasteMode((cur) => (cur === mode ? null : mode));
  };

  const applyPaste = (field: PasteField) => {
    setError(null); setNotice(null);
    if (!pasteText.trim()) { setError("Paste something first."); return; }

    if (pasteMode === "both") {
      const split = splitFleetLines(pasteText);
      if (!split) {
        setError("Couldn't find two empire sections to split on — paste a table with an " +
          "empire-name line before each fleet, or use one of the single-fleet buttons instead.");
        return;
      }
      const att = matchAgainstCatalog(split[0], allShips);
      const def = matchAgainstCatalog(split[1], allShips);
      const attResult = rowsFromMatched(att.matched, field);
      const defResult = rowsFromMatched(def.matched, field);
      if (att.race) setAttackerRace(att.race);
      setAttackerRows(attResult.rows);
      if (def.race) setDefenderRace(def.race);
      setDefenderRows(defResult.rows);
      setNotice(`${summarize("Attacker", att, field, attResult.applied, attResult.truncated)} ` +
        summarize("Defender", def, field, defResult.applied, defResult.truncated));
    } else {
      const lines = parseFleetLines(pasteText);
      const m = matchAgainstCatalog(lines, allShips);
      const result = rowsFromMatched(m.matched, field);
      if (pasteMode === "attacker") {
        if (m.race) setAttackerRace(m.race);
        setAttackerRows(result.rows);
        setNotice(summarize("Attacker", m, field, result.applied, result.truncated));
      } else {
        if (m.race) setDefenderRace(m.race);
        setDefenderRows(result.rows);
        setNotice(summarize("Defender", m, field, result.applied, result.truncated));
      }
    }
    setPasteMode(null);
    setPasteText("");
  };

  const toShips = (rows: ShipRow[]): SimShipEntry[] =>
    rows.filter((r) => r.shipTypeId && Number(r.count) > 0)
      .map((r) => ({ ship_type_id: Number(r.shipTypeId), count: Number(r.count) }));

  const fillWithDummyStacks = () => {
    const lightFighterId = allShips.find((s) => s.name === "Light fighter-drone")?.id;
    if (lightFighterId == null) {
      setError("Light fighter-drone ship type not found in the catalog.");
      return;
    }
    const fillDummy = (rows: ShipRow[]) => rows.map((row) => (
      !row.shipTypeId || row.shipTypeId === "" ?
        { shipTypeId: String(lightFighterId), count: "1" } : row
    ));
    setAttackerRows((rows) => fillDummy(rows));
    setDefenderRows((rows) => fillDummy(rows));
    setNotice("Filled empty attacker and defender rows with Light fighter-drone stacks.");
  };

  const clearFleets = () => {
    setAttackerRows(emptyRows());
    setDefenderRows(emptyRows());
    setNotice("Cleared attacker and defender tables.");
  };

  const isAttackerPowerRatingValid = (rating: number | null): rating is number =>
    rating !== null && Number.isFinite(rating) && rating !== 100 && rating >= 1 && rating <= 1000;

  const scaleAttackerRows = (attackerRowsInput: ShipRow[], defenderRowsInput: ShipRow[]) => {
    if (!isAttackerPowerRatingValid(attackerPowerRating)) return attackerRowsInput;
    const powerById = new Map(allShips.map((s) => [s.id, s.power]));
    const attackerNonzero = attackerRowsInput.filter((r) => r.shipTypeId && Number(r.count) > 0);

    const attackerPower = attackerNonzero.reduce((sum, row) => {
      const power = powerById.get(Number(row.shipTypeId)) ?? 0;
      return sum + power * Number(row.count);
    }, 0);
    const defenderPower = defenderRowsInput.reduce((sum, row) => {
      if (!row.shipTypeId || Number(row.count) <= 0) return sum;
      const power = powerById.get(Number(row.shipTypeId)) ?? 0;
      return sum + power * Number(row.count);
    }, 0);
    if (attackerPower <= 0 || defenderPower <= 0) return attackerRowsInput;

    const targetPower = defenderPower * (attackerPowerRating / 100);
    const scaleRatio = targetPower / attackerPower;
    if (!Number.isFinite(scaleRatio) || scaleRatio === 1) return attackerRowsInput;

    return attackerRowsInput.map((row) => {
      if (!row.shipTypeId || Number(row.count) <= 1) return row;
      const count = Number(row.count);
      const newCount = Math.max(2, Math.round(count * scaleRatio));
      return { ...row, count: String(newCount) };
    });
  };

  const applyAttackerPowerRating = () => {
    const scaled = scaleAttackerRows(attackerRows, defenderRows);
    setAttackerRows(scaled);
    if (scaled === attackerRows) {
      setNotice("No attacker adjustment applied. Ensure the attacker has multiple stacks and the power rating is valid.");
    } else {
      setNotice(`Applied attacker power rating ${attackerPowerRating}% to the fleet.`);
    }
  };

  const runBattle = (
    attackerShipsBody: SimShipEntry[],
    defenderShipsBody: SimShipEntry[],
    emptyMessage = "Both sides need at least one ship with a count.",
  ) => {
    setError(null);
    if (attackerShipsBody.length === 0 || defenderShipsBody.length === 0) {
      setError(emptyMessage);
      return;
    }
    try {
      setReport(battleSimBatch(SHIPS_BY_ID, {
        attacker: { race: attackerRace, ships: attackerShipsBody },
        defender: { race: defenderRace, ships: defenderShipsBody },
        attitude, enslave, attacker_power_rating: attackerPowerRating ?? undefined,
      }));
    } catch (e) {
      setError(e instanceof SimError ? e.message : "Simulation failed");
    }
  };

  const run = () => {
    const scaledAttackerRows = scaleAttackerRows(attackerRows, defenderRows);
    if (scaledAttackerRows !== attackerRows) {
      setAttackerRows(scaledAttackerRows);
    }
    runBattle(toShips(scaledAttackerRows), toShips(defenderRows));
  };

  // Maps a post-battle fleet's survivors back to ShipRows by matching each entry's name
  // against the ship IDs actually submitted for this side (rather than re-matching against
  // the full catalog) — that's unambiguous even for races that can crew foreign hulls.
  const rowsFromRemainingFleet = (fleet: BattleFleetEntry[], sourceRows: ShipRow[]): ShipRow[] => {
    const idByName = new Map<string, number>();
    for (const r of sourceRows) {
      if (!r.shipTypeId) continue;
      const ship = allShips.find((s) => s.id === Number(r.shipTypeId));
      if (ship) idByName.set(ship.name.toLowerCase(), ship.id);
    }
    const usable = fleet
      .filter((f) => f.remaining > 0 && idByName.has(f.name.toLowerCase()))
      .map((f) => ({ id: idByName.get(f.name.toLowerCase())!, remaining: f.remaining, power: f.unit_power }))
      .sort((a, b) => b.power * b.remaining - a.power * a.remaining);
    const rows = emptyRows();
    usable.slice(0, ROWS).forEach((m, i) => { rows[i] = { shipTypeId: String(m.id), count: String(m.remaining) }; });
    return rows;
  };

  const runAgainWithRemaining = () => {
    if (!report) return;
    const b = report.report;
    const newAttackerRows = rowsFromRemainingFleet(b.attacker_fleet, attackerRows);
    const newDefenderRows = rowsFromRemainingFleet(b.defender_fleet, defenderRows);
    setAttackerRows(newAttackerRows);
    setDefenderRows(newDefenderRows);
    runBattle(
      toShips(newAttackerRows), toShips(newDefenderRows),
      "One side has no surviving ships — can't continue the fight.",
    );
  };

  if (report) {
    const b = report.report;
    const attackerLabel = `Attacker (${attackerRace})`;
    const defenderLabel = `Defender (${defenderRace})`;
    const fleetStartPower = (rows: BattleFleetEntry[]) => rows.reduce((s, r) => s + r.total_power, 0);
    const attackerStartPower = fleetStartPower(b.attacker_fleet);
    const defenderStartPower = fleetStartPower(b.defender_fleet);
    const attackerLossesPower = b.attacker_pr_lost;
    const defenderLossesPower = b.defender_pr_lost;
    const attackerRemainingPower = attackerStartPower - attackerLossesPower;
    const defenderRemainingPower = defenderStartPower - defenderLossesPower;
    const netPower = defenderLossesPower - attackerLossesPower;
    const defenderPowerLostPct = b.defender_kill_pct * 100;
    const bothSidesHaveSurvivors = b.attacker_fleet.some((f) => f.remaining > 0)
      && b.defender_fleet.some((f) => f.remaining > 0);
    const fleetTable = (rows: BattleFleetEntry[]) => (
      <table className="colony-table">
        <thead><tr><th>Name</th><th className="num">Units</th><th className="num">Unit Power</th><th className="num">Total Power</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="mono">{r.name}</td>
              <td className="num">{full(r.units)}</td>
              <td className="num">{full(r.unit_power)}</td>
              <td className="num">{full(r.total_power)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="hint">No stacks.</td></tr>}
        </tbody>
      </table>
    );

    return (
      <div className="app">
        <TopBar title={`${attackerLabel} vs ${defenderLabel}`} />
        <main className="content content--wide">
          <div className={b.winner === "attacker" ? "notice" : "error"}>
            <div>
              <strong>{b.winner === "attacker" ? "Attacker wins" : "Defender wins"}</strong> ({b.attitude}
              {b.enslave ? ", enslave" : ""}) — attacker killed {(b.defender_kill_pct * 100).toFixed(1)}%
              of the defender's fleet, lost {(b.attacker_loss_pct * 100).toFixed(1)}% of its own.
              {" "}PR lost — attacker {full(b.attacker_pr_lost)}, defender {full(b.defender_pr_lost)}.
              {b.colonies_captured > 0 && ` Attacker would capture ${b.colonies_captured} colony(ies).`}
            </div>
            <div>
              {report.runs} battles tested: {report.wins}/{report.runs} are wins, {report.losses}/{report.runs} are
              losses, median chance to win: {report.win_rate.toFixed(1)}%
            </div>
          </div>

          <section className="panel">
            <div className="panel-title">Power Summary</div>
            <table className="colony-table">
              <thead>
                <tr>
                  <th></th>
                  <th className="num">Power (Start)</th>
                  <th className="num">Power (Remaining)</th>
                  <th className="num">Losses (Power Lost)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{attackerLabel}</td>
                  <td className="num">{full(attackerStartPower)}</td>
                  <td className="num">{full(attackerRemainingPower)}</td>
                  <td className="num">{full(attackerLossesPower)}</td>
                </tr>
                <tr>
                  <td>{defenderLabel}</td>
                  <td className="num">{full(defenderStartPower)}</td>
                  <td className="num">{full(defenderRemainingPower)}</td>
                  <td className="num">{full(defenderLossesPower)}</td>
                </tr>
              </tbody>
            </table>
            <p className="hint">
              Net Power (defender lost − attacker lost): {netPower >= 0 ? "+" : ""}{full(netPower)}
              {" "}· Defender Power Lost: {defenderPowerLostPct.toFixed(1)}%
            </p>
          </section>

          <section className="panel">
            <div className="panel-title">Battle Result</div>
            <table className="colony-table">
              <thead>
                <tr><th>Name</th><th className="num">Units</th><th className="num">Casualties</th><th className="num">Remaining</th></tr>
              </thead>
              <tbody>
                <tr><td colSpan={4} className="hint">{attackerLabel}</td></tr>
                {b.attacker_fleet.map((r) => (
                  <tr key={`a-${r.name}`}>
                    <td className="mono">{r.name}</td>
                    <td className="num">{full(r.units)}</td>
                    <td className="num">{full(r.casualties)}</td>
                    <td className="num">{full(r.remaining)}</td>
                  </tr>
                ))}
                <tr><td colSpan={4} className="hint">{defenderLabel}</td></tr>
                {b.defender_fleet.map((r) => (
                  <tr key={`d-${r.name}`}>
                    <td className="mono">{r.name}</td>
                    <td className="num">{full(r.units)}</td>
                    <td className="num">{full(r.casualties)}</td>
                    <td className="num">{full(r.remaining)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="attack-actions">
            <button className="btn btn-primary" onClick={() => setReport(null)}>Run Another Sim</button>
            <button
              className="btn btn-secondary" disabled={!bothSidesHaveSurvivors}
              title={bothSidesHaveSurvivors ? undefined : "One side was wiped out — nothing left to continue with."}
              onClick={runAgainWithRemaining}
            >
              Run Again With Remaining Fleets
            </button>
          </div>

          <div className="attack-grid">
            <section className="panel">
              <div className="panel-title">{attackerLabel} — Fleet Power</div>
              {fleetTable(b.attacker_fleet)}
            </section>
            <section className="panel">
              <div className="panel-title">{defenderLabel} — Fleet Power</div>
              {fleetTable(b.defender_fleet)}
            </section>
          </div>

          <section className="panel">
            <div className="panel-title">Detailed Battle Log</div>
            <div className="battle-log">
              {b.log.map((entry, i) => {
                if (entry.outcome === "wiped") {
                  return (
                    <p key={i} className="battle-log-line battle-log-line--wiped">
                      {entry.actor} wipes out {entry.target}!
                    </p>
                  );
                }
                if (entry.outcome === "loss") {
                  return (
                    <p key={i} className="battle-log-line battle-log-line--muted">
                      {entry.actor} damages {entry.target}, destroying {entry.count}.
                    </p>
                  );
                }
                return (
                  <p key={i} className="battle-log-line battle-log-line--muted">
                    {entry.actor} damages {entry.target}.
                  </p>
                );
              })}
              {b.log.length === 0 && <p className="hint">No exchanges recorded.</p>}
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar title="Battle Sim" />

      <main className="content content--wide">
        {error && <div className="error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}

        <section className="panel">
          <div className="panel-title">Quick Setup</div>
          <div className="turn-actions">
            <button className={`btn btn-sm ${pasteMode === "attacker" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => togglePaste("attacker")}>Paste Attacker Fleet</button>
            <button className={`btn btn-sm ${pasteMode === "both" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => togglePaste("both")}>Paste Both Fleets</button>
            <button className={`btn btn-sm ${pasteMode === "defender" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => togglePaste("defender")}>Paste Defender Fleet</button>
            <button className="btn btn-sm btn-secondary" onClick={fillWithDummyStacks}>Fill With Dummy Stacks</button>
            <button className="btn btn-sm btn-secondary" onClick={swapFleets}>⇄ Swap Fleets</button>
            <button className="btn btn-sm btn-secondary" onClick={clearFleets}>Clear Tables</button>
          </div>
          {pasteMode && (
            <div style={{ marginTop: 10 }}>
              <p className="hint">
                Paste a copied fleet/battle table (Name, Units, Casualties, Remaining columns).
                Choose which column to load counts from: "Full" uses Units (the stack size
                before battle), "Remaining" uses what survived. For "Both Fleets", put an
                empire-name line before each side's ships — that's the split point. Race is
                detected from the ship names.
              </p>
              <textarea rows={8} style={{ width: "100%" }} value={pasteText}
                        onChange={(e) => setPasteText(e.target.value)}
                        placeholder={"Name\tUnits\tCasualties\tRemaining\nJasper89c\nK.Hun-Li\t5\t5\t0\n…"} />
              <div className="attack-actions">
                <button className="btn btn-ghost" onClick={() => togglePaste(pasteMode)}>Cancel</button>
                <button className="btn btn-secondary" onClick={() => applyPaste("units")}>Full</button>
                <button className="btn btn-primary" onClick={() => applyPaste("remaining")}>Remaining</button>
              </div>
            </div>
          )}

          <div className="market-field" style={{ marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="market-field__label">Attacker Power Rating %</span>
              <span style={{ color: "#666", fontSize: "0.95rem" }}>130 = 130% above, 1.3m vs 1m</span>
            </div>
            <div className="market-field__input-group">
              {[75, 130, 150].map((preset) => (
                <button
                  key={preset}
                  className={`btn btn-sm ${attackerPowerRating === preset ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setAttackerPowerRating(preset)}
                >
                  {preset}%
                </button>
              ))}
              <input
                type="number"
                min="1"
                max="1000"
                value={attackerPowerRating ?? ""}
                onChange={(e) => setAttackerPowerRating(Number(e.target.value))}
                placeholder="Enter % (e.g., 130)"
                style={{ width: "120px" }}
              />
              <button
                className="btn btn-sm btn-primary"
                onClick={applyAttackerPowerRating}
                disabled={!isAttackerPowerRatingValid(attackerPowerRating)}
              >
                Apply
              </button>
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => setAttackerPowerRating(null)}
                disabled={attackerPowerRating === null}
              >
                Reset
              </button>
            </div>
          </div>
        </section>

        <div className="attack-grid">
          <SideEditor
            title="Attacker" races={races} race={attackerRace} onRace={onAttackerRace}
            ships={attackerShips} allShips={allShips} rows={attackerRows} onRow={updateAttackerRow}
            onSettle={settleAttackerRows}
          />
          <SideEditor
            title="Defender" races={races} race={defenderRace} onRace={onDefenderRace}
            ships={defenderShips} allShips={allShips} rows={defenderRows} onRow={updateDefenderRow}
            onSettle={settleDefenderRows}
          />
        </div>

        <section className="panel">
          <div className="panel-title">Attacking Directive</div>
          <div className="market-field">
            <span className="market-field__label">Enslave Attempt</span>
            <input type="checkbox" checked={enslave} onChange={(e) => setEnslave(e.target.checked)} style={{ width: "auto" }} />
          </div>
          <div className="market-field">
            <span className="market-field__label">Fleet Attitude</span>
            <select value={attitude} onChange={(e) => setAttitude(e.target.value)}>
              {ATTITUDES.map((a) => <option key={a} value={a}>{a[0].toUpperCase() + a.slice(1)}</option>)}
            </select>
          </div>
          <p className="hint">
            Careful ×0.5 dmg · Normal attacker ×0.95 / defender ×1.0 · Aggressive attacker ×1.75 / defender ×1.99.
            Normal win: kill ≥10% &amp; lose less. Enslave win: kill ≥60%.
            <br />
            <br />
            <strong>Attacker Power Rating % (130 = 130% above, 1.3m vs 1m):</strong> Scale attacker fleet to match this percentage of defender's total power.
            For example, 130% means attacker fleet will be 30% stronger than defender.
          </p>
          <div className="attack-actions">
            <button className="btn btn-primary" onClick={run}>Run Battle</button>
          </div>
        </section>
      </main>
    </div>
  );
}
