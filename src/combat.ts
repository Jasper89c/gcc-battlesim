// Battle resolution engine — TypeScript port of the GCR backend's app/sims/combat.py.
//
// Kept line-for-line equivalent to the Python so the two can be checked against each other
// (see test/parity.test.ts): same function names, same order of operations, same
// truncation points. Change one, change the other.
//
// Pure functions; no DOM/network.
// Damage per phase (per the guide):
//     total = sum over damage types of (ships * dmg * attitude_mod * opp_shield_factor)
//     shield_factor = 1 - shield_mod/100   (+20% -> x0.8 reduce; -30% -> x1.3 amplify)
//     retaliation phases deal half damage.
// Ships destroyed = total_damage / opposing_ship_hull (fractional carries; ships are
// auto-repaired after battle, so leftover damage doesn't reduce a survivor's output).

// Attitude modifiers. The attacker chooses the attitude; each side's ships use their
// own side's modifier in every phase (attacker vs defender), per the guide.
export const ATTACKER_MOD: Record<string, number> = { careful: 0.5, normal: 0.95, aggressive: 1.75 };
export const DEFENDER_MOD: Record<string, number> = { careful: 0.5, normal: 1.0, aggressive: 1.99 };

export const MAX_STACKS = 10;

export interface CombatShip {
  name: string;
  power: number;
  hull: number;
  ship_range: number;
  energy: number;
  kinetic: number;
  missile: number;
  chemical: number;
  energy_shield: number;      // vs energy
  absorption_shield: number;  // vs kinetic
  missile_shield: number;     // vs missile
  chemical_shield: number;    // vs chemical
  no_def: boolean;            // cannot retaliate when attacked
  no_retal: boolean;          // ships it attacks cannot retaliate
  capture_rate: number;       // % chance to capture ships it destroys
  capturable: boolean;        // can this ship be captured by a capturing stack
}

export interface Stack {
  ship: CombatShip;
  count: number;
  mod: number;                       // this stack's side attitude modifier
  side: string;                      // "A" (attacker) or "D" (defender)
  start_count: number;
  captured: Map<string, number>;     // ship name -> count captured
}

export function makeStack(ship: CombatShip, count: number, mod: number): Stack {
  return { ship, count, mod, side: "", start_count: count, captured: new Map() };
}

const pr = (s: Stack) => s.ship.power * s.count;
const alive = (s: Stack) => s.count >= 1.0;

/** +20 -> 0.8 (reduce), -30 -> 1.3 (amplify). Never negative. */
function shieldFactor(mod: number): number {
  return Math.max(0.0, 1 - mod / 100.0);
}

function damage(attacker: Stack, target: CombatShip, half = false): number {
  const s = Math.max(0.0, attacker.count);
  const a = attacker.mod;
  const total =
    s * attacker.ship.energy * a * shieldFactor(target.energy_shield)
    + s * attacker.ship.kinetic * a * shieldFactor(target.absorption_shield)
    + s * attacker.ship.missile * a * shieldFactor(target.missile_shield)
    + s * attacker.ship.chemical * a * shieldFactor(target.chemical_shield);
  return half ? total / 2.0 : total;
}

/** One side's stack acting on an opposing stack, and the immediate result. */
export interface BattleLogEntry {
  actor_side: string;        // "A" (attacker) or "D" (defender)
  actor_ship: string;
  target_side: string;
  target_ship: string;
  outcome: "loss" | "wiped" | "damaged";
  count: number;             // ships lost this exchange (for outcome == "loss")
}

/** Apply damage to target; if the attacker has capture, log captured ships. */
function apply(attacker: Stack, target: Stack, dmg: number, log: BattleLogEntry[] | null): void {
  if (dmg <= 0 || target.ship.hull <= 0) return;
  const before = target.count;
  if (before < 1.0) return;
  target.count = Math.max(0.0, target.count - dmg / target.ship.hull);
  const after = target.count;
  const destroyed = before - after;
  if (destroyed > 0 && attacker.ship.capture_rate > 0 && target.ship.capturable) {
    attacker.captured.set(
      target.ship.name,
      (attacker.captured.get(target.ship.name) ?? 0.0) + destroyed * attacker.ship.capture_rate / 100.0,
    );
  }
  if (log !== null) {
    let outcome: BattleLogEntry["outcome"] = "damaged";
    let count = 0;
    if (after < 1.0) outcome = "wiped";
    else if (destroyed >= 1.0) { outcome = "loss"; count = Math.trunc(destroyed); }
    log.push({
      actor_side: attacker.side, actor_ship: attacker.ship.name,
      target_side: target.side, target_ship: target.ship.name,
      outcome, count,
    });
  }
}

// blocked if the retaliator has No Defense, or the attacker has No Retaliation
function canRetaliate(retaliator: Stack, attacker: Stack): boolean {
  return !(retaliator.ship.no_def || attacker.ship.no_retal);
}

/** One stack-vs-stack exchange. Higher range goes first; tie -> defender (d) first.
 *
 * Round A: first attacks (full) + second retaliates (half), both at starting counts.
 * Round B: second attacks (full) + first retaliates (half), at post-round-A counts. */
export function resolvePair(a: Stack, d: Stack, log: BattleLogEntry[] | null = null): void {
  const [first, second] = a.ship.ship_range > d.ship.ship_range ? [a, d] : [d, a];

  // Round A (simultaneous): first attacks second, second retaliates first
  let dmgToSecond = damage(first, second.ship);
  let dmgToFirst = canRetaliate(second, first) ? damage(second, first.ship, true) : 0.0;
  apply(first, second, dmgToSecond, log);
  apply(second, first, dmgToFirst, log);

  // Round B (simultaneous): second attacks first, first retaliates second
  dmgToFirst = damage(second, first.ship);
  dmgToSecond = canRetaliate(first, second) ? damage(first, second.ship, true) : 0.0;
  apply(second, first, dmgToFirst, log);
  apply(first, second, dmgToSecond, log);
}

/** An unopposed stack attacks a random opposing stack (full); the target may
 * retaliate once (half) if rules allow. */
function flank(flanker: Stack, target: Stack, log: BattleLogEntry[] | null): void {
  const dmg = damage(flanker, target.ship);
  const retal = canRetaliate(target, flanker) ? damage(target, flanker.ship, true) : 0.0;
  apply(flanker, target, dmg, log);
  apply(target, flanker, retal, log);
}

/** Picks one element of a non-empty list — the only source of randomness in a battle. */
export type Choice = <T>(items: T[]) => T;

const randomChoice: Choice = (items) => items[Math.floor(Math.random() * items.length)];

export interface BattleResult {
  winner: "attacker" | "defender";
  attacker_pr_start: number;
  defender_pr_start: number;
  attacker_pr_lost: number;
  defender_pr_lost: number;
  defender_kill_pct: number;
  attacker_loss_pct: number;
  colonies_lost: number;                      // by the defender (captured by attacker)
  attacker_losses: Record<string, number>;    // ship name -> count lost
  defender_losses: Record<string, number>;
  attacker_captures: Record<string, number>;  // ship name -> count the attacker captured
  defender_captures: Record<string, number>;
  log: BattleLogEntry[];
}

function runWave(att: Stack[], dfn: Stack[], choice: Choice, log: BattleLogEntry[] | null): void {
  const pairs = Math.min(att.length, dfn.length);
  for (let i = 0; i < pairs; i++) {
    if (alive(att[i]) && alive(dfn[i])) resolvePair(att[i], dfn[i], log);
  }
  // flanking: unopposed stacks on the longer side hit a random opposing survivor
  if (att.length > dfn.length) {
    const targets = dfn.filter(alive);
    for (const s of att.slice(pairs)) {
      if (alive(s) && targets.length) flank(s, choice(targets), log);
    }
  } else if (dfn.length > att.length) {
    const targets = att.filter(alive);
    for (const s of dfn.slice(pairs)) {
      if (alive(s) && targets.length) flank(s, choice(targets), log);
    }
  }
}

/** The strongest MAX_STACKS stacks by power rating — the ones that actually fight. */
export function topStacks(stacks: Stack[]): Stack[] {
  return [...stacks].sort((a, b) => pr(b) - pr(a)).slice(0, MAX_STACKS);
}

export function resolveBattle(
  attacker: Stack[], defender: Stack[],
  { enslave = false, choice = randomChoice, defenderDpColoniesLost = 0 }:
    { enslave?: boolean; choice?: Choice; defenderDpColoniesLost?: number } = {},
): BattleResult {
  const log: BattleLogEntry[] = [];
  let att = topStacks(attacker);
  let dfn = topStacks(defender);
  const attFought = [...att];  // pre-battle top-MAX_STACKS selection, frozen before counts mutate
  const dfnFought = [...dfn];
  for (const s of att) s.side = "A";
  for (const s of dfn) s.side = "D";
  const attPr0 = att.reduce((sum, s) => sum + pr(s), 0);
  const dfnPr0 = dfn.reduce((sum, s) => sum + pr(s), 0);

  // Wave 1 (paired by PR rank), then compact wiped stacks, then Wave 2 (no re-sort).
  runWave(att, dfn, choice, log);
  att = att.filter(alive);
  dfn = dfn.filter(alive);
  runWave(att, dfn, choice, log);

  // A stack wiped in wave 1 was compacted out, so it counts as fully lost; one that drops
  // below a whole ship in wave 2 is still in the list and keeps its fractional count.
  const losses = (stacksAfter: Stack[], originals: Stack[]): [number, Record<string, number>] => {
    const after = new Set(stacksAfter);
    let prLost = 0.0;
    const lost: Record<string, number> = {};
    for (const o of originals) {
      const endCount = after.has(o) ? o.count : 0.0;
      const killed = Math.max(0.0, o.start_count - endCount);
      if (killed >= 1) lost[o.ship.name] = (lost[o.ship.name] ?? 0) + Math.trunc(killed);
      prLost += killed * o.ship.power;
    }
    return [prLost, lost];
  };

  const [attPrLost, attLost] = losses(att, attFought);
  const [dfnPrLost, dfnLost] = losses(dfn, dfnFought);

  const dfnKillPct = dfnPr0 ? dfnPrLost / dfnPr0 : 0.0;
  const attLossPct = attPr0 ? attPrLost / attPr0 : 0.0;
  const attackerHasSurvivor = att.some(alive);
  const threshold = enslave ? 0.60 : 0.10;
  // A defender with no fleet can't lose ships, so the kill thresholds are unreachable —
  // an undefended target is simply a win for any attacker that fielded ships.
  const attackerWon = attackerHasSurvivor && (
    dfnFought.length === 0 || (attPrLost < dfnPrLost && dfnKillPct >= threshold)
  );

  let colonies = 0;
  if (attackerWon && dfnFought.length === 0) {
    // Nothing to kill, so the kill-% tiers don't apply: take what's left of the 3-colony
    // DP cycle (the defender hits Damage Protection at 3 colonies lost), at least 1.
    colonies = Math.max(1, 3 - defenderDpColoniesLost);
  } else if (attackerWon) {
    colonies = dfnKillPct >= 0.80 ? 3 : dfnKillPct >= 0.50 ? 2 : 1;
  }

  // captures: only the WINNING side, and only from capturing stacks that survived
  const captures = (stacks: Stack[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const s of stacks) {
      if (!alive(s)) continue;  // "if your capturing stack is destroyed, you capture nothing"
      for (const [name, cnt] of s.captured) {
        if (Math.trunc(cnt) >= 1) out[name] = (out[name] ?? 0) + Math.trunc(cnt);
      }
    }
    return out;
  };

  const winner = attackerWon ? "attacker" : "defender";
  return {
    winner,
    attacker_pr_start: attPr0, defender_pr_start: dfnPr0,
    attacker_pr_lost: attPrLost, defender_pr_lost: dfnPrLost,
    defender_kill_pct: dfnKillPct, attacker_loss_pct: attLossPct,
    colonies_lost: colonies, attacker_losses: attLost, defender_losses: dfnLost,
    attacker_captures: winner === "attacker" ? captures(att) : {},
    defender_captures: winner === "defender" ? captures(dfn) : {},
    log,
  };
}

// --------------------------------------------------- adapters from catalog data
/** Extract the capture % from a ship's specials (0 if none). */
export function parseCaptureRate(specials: string[]): number {
  for (const raw of specials) {
    const m = raw.match(/(\d+(?:\.\d+)?)\s*%\s*chance of capturing/i);
    if (m) return Number(m[1]);
  }
  return 0.0;
}

// Ships capturable per the combat guide: Terran / Aspha Miner / Marauder, excluding
// D- and G-class hulls, Starbases, and Scouts.
const CAPTURABLE_RACES = new Set(["Terran", "Aspha Miner", "Marauder"]);

export function isCapturable(race: string, shipClass: string, name: string): boolean {
  if (!CAPTURABLE_RACES.has(race)) return false;
  if (shipClass === "Starbase" || shipClass === "Scout") return false;
  const prefix = name.includes(".") ? name.split(".")[0] : "";
  return prefix !== "D" && prefix !== "G";
}

const SHIELD_KEYS = {
  "energy shield": "energy_shield",
  "absorption shield": "absorption_shield",
  "missile shield": "missile_shield",
  "chemical shield": "chemical_shield",
} as const;

type Shields = Record<(typeof SHIELD_KEYS)[keyof typeof SHIELD_KEYS], number>;

/** Parse ['Energy Shield - 20 %', 'Absorption Shield + 20 %', ...] -> shield mods. */
export function parseShields(defenseModifiers: string[]): Shields {
  const out: Shields = { energy_shield: 0.0, absorption_shield: 0.0, missile_shield: 0.0, chemical_shield: 0.0 };
  for (const raw of defenseModifiers) {
    const m = raw.match(/^\s*(.+?)\s*([+-])\s*([\d.]+)\s*%/);
    if (!m) continue;
    const label = SHIELD_KEYS[m[1].trim().toLowerCase() as keyof typeof SHIELD_KEYS];
    if (label) out[label] = Number(m[3]) * (m[2] === "+" ? 1 : -1);
  }
  return out;
}

/** Return [no_def, no_retal] from a ship's specials text. */
export function deriveSpecials(specials: string[]): [boolean, boolean] {
  const text = specials.join(" ").toLowerCase();
  return [text.includes("no defense"), text.includes("no retaliation")];
}
