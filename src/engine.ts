// Battle Sim orchestration — TypeScript port of the battle half of the GCR backend's
// app/sims/engine.py and app/api/sims.py. Builds stacks from the ship catalog, runs the
// battle(s) and shapes the report the page renders. Nothing here touches the network.

import {
  ATTACKER_MOD, DEFENDER_MOD, MAX_STACKS, deriveSpecials, isCapturable, makeStack, parseCaptureRate,
  parseShields, resolveBattle, topStacks,
  type BattleResult, type Choice, type CombatShip, type Stack,
} from "./combat.ts";

export interface ShipType {
  id: number;
  race: string;
  name: string;
  ship_class: string;
  energy: number;
  kinetic: number;
  missile: number;
  chemical: number;
  hull: number;
  ship_range: number;
  power: number;
  specials: string[];
  defense_modifiers: string[];
}

export interface SimShipEntry {
  ship_type_id: number;
  count: number;
}
export interface BattleSimSide {
  race: string;
  ships: SimShipEntry[];
}
export interface BattleFleetEntry {
  name: string;
  units: number;
  casualties: number;
  remaining: number;
  unit_power: number;
  total_power: number;
}
export interface BattleLogLine {
  actor: string;
  target: string;
  outcome: string; // "loss" | "wiped" | "damaged"
  loser: string | null;
  ship: string | null;
  count: number | null;
}
export interface BattleSimReport {
  winner: string;
  attitude: string;
  enslave: boolean;
  defender_kill_pct: number;
  attacker_loss_pct: number;
  colonies_captured: number;
  attacker_pr_lost: number;
  defender_pr_lost: number;
  attacker_losses: Record<string, number>;
  defender_losses: Record<string, number>;
  attacker_fleet: BattleFleetEntry[];
  defender_fleet: BattleFleetEntry[];
  log: BattleLogLine[];
}
export interface BattleSimBatchReport {
  report: BattleSimReport;
  runs: number;
  wins: number;
  losses: number;
  win_rate: number;
}

// Every race with a sim ship list, in the backend's RACES_SIM order. Kal-Zul and D.Marauder
// are admin-only/NPC races in the game but selectable here; Event and Bastion exist for
// paste-matching only (the page hides them from its dropdowns).
export const RACES = [
  "Terran", "Aspha Miner", "Guardian", "Marauder", "Viral", "Collective",
  "Kal-Zul", "D.Marauder", "Event", "Bastion",
];

// Races that can crew foreign hulls in the Battle Sim, mirroring the live game: Viral
// reverse-engineers a limited catalog of foreign ships, Collective keeps whatever it
// captures as-is — both draw from the same three source races, so a Viral or Collective
// side is allowed ships from those races too, not just its own + Neutral.
export const FOREIGN_HULL_RACES = new Set(["Viral", "Collective"]);
export const FOREIGN_HULL_SOURCE_RACES = new Set(["Terran", "Aspha Miner", "Marauder"]);

// Event (the hidden bonus-ship pool) also gets to field real Guardian hulls in the Battle
// Sim — several Event ships are Guardian-flavored variants of the same tier.
export const EVENT_RACE = "Event";
export const EVENT_SOURCE_RACES = new Set(["Guardian"]);

/** Which ShipType.race values a side may field, given its selected race. */
export function allowedShipRaces(race: string): Set<string> {
  const allowed = new Set([race, "Neutral"]);
  if (FOREIGN_HULL_RACES.has(race)) for (const r of FOREIGN_HULL_SOURCE_RACES) allowed.add(r);
  if (race === EVENT_RACE) for (const r of EVENT_SOURCE_RACES) allowed.add(r);
  return allowed;
}

/** The ships a side of the given race may pick from, in catalog order (weakest first). */
export function shipsForRace(catalog: ShipType[], race: string): ShipType[] {
  const allowed = allowedShipRaces(race);
  return catalog.filter((s) => allowed.has(s.race));
}

const MAX_SHIP_COUNT = 100_000_000;

/** Raised for invalid Battle Sim input. */
export class SimError extends Error {}

/** Python's round(): halves go to the nearest even integer, where Math.round sends them up. */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff !== 0.5) return diff < 0.5 ? floor : floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

function combatShip(st: ShipType): CombatShip {
  const sh = parseShields(st.defense_modifiers);
  const [no_def, no_retal] = deriveSpecials(st.specials);
  return {
    name: st.name, power: st.power, hull: st.hull, ship_range: st.ship_range,
    energy: st.energy, kinetic: st.kinetic, missile: st.missile, chemical: st.chemical,
    ...sh, no_def, no_retal,
    capture_rate: parseCaptureRate(st.specials),
    capturable: isCapturable(st.race, st.ship_class, st.name),
  };
}

function fleetEntries(fought: Stack[], losses: Record<string, number>): BattleFleetEntry[] {
  return fought.map((s) => {
    const units = Math.trunc(s.start_count);
    const casualties = losses[s.ship.name] ?? 0;
    return {
      name: s.ship.name, units, casualties,
      remaining: Math.max(0, units - casualties),
      unit_power: s.ship.power, total_power: units * s.ship.power,
    };
  });
}

export interface BattleSimRequest {
  attacker: BattleSimSide;
  defender: BattleSimSide;
  attitude: string;
  enslave: boolean;
  attacker_power_rating?: number;
}

interface FoughtBattle {
  result: BattleResult;
  attacker_fleet: BattleFleetEntry[];
  defender_fleet: BattleFleetEntry[];
}

/** Pure what-if battle: stacks are built from the ship catalog by id. */
export function simulateBattleSim(
  shipsById: Map<number, ShipType>, body: BattleSimRequest, choice?: Choice,
): FoughtBattle {
  const { attitude, enslave, attacker_power_rating: rating } = body;
  if (!(attitude in ATTACKER_MOD)) throw new SimError("Attitude must be careful, normal, or aggressive.");
  if (rating !== undefined && !(Number.isInteger(rating) && rating >= 1 && rating <= 1000)) {
    throw new SimError("Attacker power rating must be a whole number from 1 to 1000.");
  }
  // Same limits the backend's request schema enforced before a battle ever ran.
  for (const side of [body.attacker, body.defender]) {
    if (side.ships.length > MAX_STACKS) throw new SimError(`A side can field at most ${MAX_STACKS} stacks.`);
    if (side.ships.some((s) => !(Number.isInteger(s.count) && s.count > 0 && s.count <= MAX_SHIP_COUNT))) {
      throw new SimError("Ship counts must be whole numbers from 1 to 100,000,000.");
    }
  }

  const build = (ships: SimShipEntry[], race: string, mod: number): Stack[] => {
    const allowed = allowedShipRaces(race);
    const stacks: Stack[] = [];
    for (const { ship_type_id, count } of ships) {
      if (count <= 0) continue;
      const st = shipsById.get(ship_type_id);
      if (!st || !allowed.has(st.race)) throw new SimError(`Invalid ship selection for ${race}.`);
      stacks.push(makeStack(combatShip(st), count, mod));
    }
    if (!stacks.length) throw new SimError(`${race} side needs at least one ship.`);
    return stacks;
  };

  let attackerShips = body.attacker.ships;
  if (rating !== undefined && rating !== 100) {
    const fleetPower = (ships: SimShipEntry[]) => ships.reduce(
      (sum, s) => (s.count > 0 ? sum + (shipsById.get(s.ship_type_id)?.power ?? 0) * s.count : sum), 0,
    );
    const attackerPower = fleetPower(attackerShips);
    const defenderPower = fleetPower(body.defender.ships);
    if (defenderPower <= 0) throw new SimError("Defender side needs at least one ship.");
    if (attackerPower <= 0) throw new SimError("Attacker side needs at least one ship.");
    const scaleRatio = defenderPower * (rating / 100) / attackerPower;
    attackerShips = attackerShips.filter((s) => s.count > 0).map((s) => (
      s.count <= 1 ? s : { ...s, count: Math.max(2, roundHalfEven(s.count * scaleRatio)) }
    ));
  }

  const attStacks = build(attackerShips, body.attacker.race, ATTACKER_MOD[attitude]);
  const dfnStacks = build(body.defender.ships, body.defender.race, DEFENDER_MOD[attitude]);
  const attFought = topStacks(attStacks);
  const dfnFought = topStacks(dfnStacks);
  const result = resolveBattle(attStacks, dfnStacks, { enslave, choice });
  return {
    result,
    attacker_fleet: fleetEntries(attFought, result.attacker_losses),
    defender_fleet: fleetEntries(dfnFought, result.defender_losses),
  };
}

export function battleSimReport(body: BattleSimRequest, fought: FoughtBattle): BattleSimReport {
  const { result } = fought;
  const sideLabel = (side: string) =>
    side === "A" ? `Attacker (${body.attacker.race})` : `Defender (${body.defender.race})`;

  return {
    winner: result.winner, attitude: body.attitude, enslave: body.enslave,
    defender_kill_pct: round4(result.defender_kill_pct),
    attacker_loss_pct: round4(result.attacker_loss_pct),
    colonies_captured: result.colonies_lost,
    attacker_pr_lost: Math.trunc(result.attacker_pr_lost),
    defender_pr_lost: Math.trunc(result.defender_pr_lost),
    attacker_losses: result.attacker_losses, defender_losses: result.defender_losses,
    attacker_fleet: fought.attacker_fleet, defender_fleet: fought.defender_fleet,
    log: result.log.map((entry) => ({
      actor: `${sideLabel(entry.actor_side)}'s ${entry.actor_ship}`,
      target: `${sideLabel(entry.target_side)}'s ${entry.target_ship}`,
      outcome: entry.outcome,
      loser: entry.outcome !== "damaged" ? sideLabel(entry.target_side) : null,
      ship: entry.outcome !== "damaged" ? entry.target_ship : null,
      count: entry.outcome === "loss" ? entry.count : null,
    })),
  };
}

export const BATTLE_SIM_BATCH_RUNS = 1000;

/** Runs the same matchup BATTLE_SIM_BATCH_RUNS times — combat has randomised flanking
 * (see combat.ts), so outcomes vary run to run — and reports the attacker's win rate
 * alongside the first run's full breakdown. */
export function battleSimBatch(
  shipsById: Map<number, ShipType>, body: BattleSimRequest, choice?: Choice,
): BattleSimBatchReport {
  let wins = 0;
  let first: FoughtBattle | null = null;
  for (let i = 0; i < BATTLE_SIM_BATCH_RUNS; i++) {
    const fought = simulateBattleSim(shipsById, body, choice);
    if (fought.result.winner === "attacker") wins += 1;
    first ??= fought;
  }
  return {
    report: battleSimReport(body, first!),
    runs: BATTLE_SIM_BATCH_RUNS, wins, losses: BATTLE_SIM_BATCH_RUNS - wins,
    win_rate: Math.round(1000 * wins / BATTLE_SIM_BATCH_RUNS) / 10,
  };
}
