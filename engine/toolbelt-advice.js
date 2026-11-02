// Toolbelt items in your bank worth putting on. For every open slot of every skill's toolbelt, the
// best item you own that fits, when it beats what's there: measured on the skill's best methods at
// your levels and on what you're doing now, or (for an empty slot) any bonus at all. Skilling sets
// are tried as a whole, since their bonus needs several pieces. Isomorphic.
import { buildEnemy, scoreGear } from './combat.js';
import { playerBonuses, playerCombatMods } from './gamedata.js';
import { bonusApplies, computeRates } from './rates.js';

const MIN_SHARE = 0.005; // under half a percent isn't worth a trip to the bank
const DAMAGE_PER_XP = 10; // in a fight, 10% less damage taken counts like 1% more XP

const share = (after, before) => (before > 0 ? after / before - 1 : 0);

// Whether a slot is open: { open: true }, { open: false, needs } or { open: null, needs } when the
// save can't tell (an Astrology node).
export function slotStatus(gd, save, slot, levels) {
  for (const r of slot.requires ?? []) {
    if (r.type === 'purchase') {
      if (!(save.shopPurchases?.[r.id] > 0)) return { open: false, needs: r.label, purchase: r.id };
    } else if (r.type === 'masteryRank') {
      if (!gd.player?.masteryRanks?.[r.skill]?.includes(r.rank)) return { open: false, needs: r.label };
    } else if (r.type === 'level') {
      if (gd.levelOf(levels, r.skill) < r.level) return { open: false, needs: `Reach ${gd.skillName(r.skill)} ${r.level}` };
    } else {
      return { open: null, needs: r.label };
    }
  }
  return { open: true };
}

// What still stops you wearing an item: level requirements you're short of, and ones the save can't check.
const itemNeeds = (gd, tool, levels) =>
  (tool.requires ?? []).filter((r) => r.type !== 'level' || gd.levelOf(levels, r.skill) < r.level).map((r) => (r.type === 'level' ? `${gd.skillName(r.skill)} ${r.level}` : r.label));

// Does an item do anything the companion can put a number on, in this skill? Combat bonuses only
// with a fight to measure them against.
function measurable(gd, skill, item, fight) {
  const tool = gd.items[item]?.tool;
  if (skill === 'Combat') return !!fight && !!tool?.mods?.length;
  const methods = gd.methodsBySkill[skill] ?? [];
  return (tool?.effects ?? []).some((e) => methods.some((m) => bonusApplies(e, m)));
}

// Runs fn with this toolbelt in the skill: fn gets the bonuses it gives, and tool requirements are
// checked against it.
function withBelt(gd, save, skill, belt, fn) {
  const toolbelts = { ...save.toolbelts, [skill]: belt };
  const was = gd.player;
  gd.player = { ...was, toolbelts };
  try {
    return fn(playerBonuses(gd, { ...save, toolbelts }));
  } finally {
    gd.player = was;
  }
}

const doable = (gd, m, levels) => {
  const req = gd.checkRequirements(m, levels);
  return req.ok && !req.equip.length && !req.unknown.length;
};

// Every method of the skill you can do with this toolbelt, with its rates; the best for XP and GP.
function skillMeasure(gd, save, skill, belt, levels) {
  return withBelt(gd, save, skill, belt, (bonuses) => {
    const per = new Map();
    let xp = null;
    let gp = null;
    for (const m of gd.methodsBySkill[skill] ?? []) {
      if (!doable(gd, m, levels)) continue;
      const r = computeRates(gd, m, gd.levelOf(levels, skill), { bonuses });
      per.set(m.key, r);
      if (!xp || r.xpPerHour > xp.xpPerHour) xp = r;
      if (!gp || r.profitPerHour > gp.profitPerHour) gp = r;
    }
    return { per, xp, gp };
  });
}

// One combat measure: the fight you'd do with this combat toolbelt.
function combatMeasure(gd, save, belt, levels, fight) {
  if (!fight) return null;
  const was = gd.playerCombatMods;
  gd.playerCombatMods = playerCombatMods(gd, { ...save, toolbelts: { ...save.toolbelts, Combat: belt } });
  try {
    const r = scoreGear(gd, { ...fight, levels, enemy: buildEnemy(gd, fight.enemy) });
    return r && !r.result.risky ? { fight: r.result } : null;
  } finally {
    gd.playerCombatMods = was;
  }
}

// How much better `after` is than `before`: one number to pick by, and the parts to describe it.
function compare(before, after, current) {
  if (!before || !after) return { score: -Infinity };
  if (before.fight || after.fight) {
    if (!before.fight || !after.fight) return { score: after.fight ? Infinity : -Infinity };
    const xp = share(after.fight.combatXpPerHour, before.fight.combatXpPerHour);
    const damageCut = before.fight.hpLossPerHour > 0 ? 1 - after.fight.hpLossPerHour / before.fight.hpLossPerHour : 0;
    return { score: xp + damageCut / DAMAGE_PER_XP, combatXp: xp, damageCut };
  }
  // Something you're doing now that this would stop you doing (it needs the tool you'd take off).
  if (current && before.per.has(current) && !after.per.has(current)) return { score: -Infinity };
  const xp = share(after.xp?.xpPerHour ?? 0, before.xp?.xpPerHour ?? 0);
  const gp = before.gp?.profitPerHour > 0 ? share(after.gp?.profitPerHour ?? 0, before.gp.profitPerHour) : 0;
  const was = current && before.per.get(current);
  const now = current && after.per.get(current);
  const cur = was && now ? { xp: share(now.xpPerHour, was.xpPerHour), gp: was.profitPerHour > 0 ? share(now.profitPerHour, was.profitPerHour) : 0, method: now.method } : null;
  // The one method it helps most, for bonuses scoped to a recipe or a spot.
  let scoped = null;
  for (const [key, b] of before.per) {
    const a = after.per.get(key);
    if (!a) continue;
    const gain = Math.max(share(a.xpPerHour, b.xpPerHour), share(a.grossPerHour, b.grossPerHour), b.costPerHour > 0 ? 1 - a.costPerHour / b.costPerHour : 0);
    if (!scoped || gain > scoped.gain) scoped = { gain, method: a.method, xp: share(a.xpPerHour, b.xpPerHour), gross: share(a.grossPerHour, b.grossPerHour), cost: b.costPerHour > 0 ? 1 - a.costPerHour / b.costPerHour : 0 };
  }
  const lost = [...before.per.keys()].filter((k) => !after.per.has(k)).map((k) => before.per.get(k).method);
  return {
    score: xp + gp + (cur ? cur.xp + cur.gp : 0),
    xp: { share: xp, method: after.xp?.method },
    gp: { share: gp, perHour: (after.gp?.profitPerHour ?? 0) - (before.gp?.profitPerHour ?? 0), method: after.gp?.method },
    current: cur,
    scoped: scoped?.gain > 0 ? scoped : null,
    lost,
  };
}

// Rough size of an item's bonuses, to order items the companion can't time: a Willow Scarecrow
// (+15 pest protection) before a Normal one (+10).
const strength = (gd, id) => [...(gd.items[id].tool.effects ?? []), ...(gd.items[id].tool.mods ?? [])].reduce((s, e) => s + Math.abs(e.value), 0);

const setBelt = (belt, slot, item, qty) => [...belt.filter((t) => t.slot !== slot && t.item !== item), { item, qty, slot }];

/**
 * @param save parsed save (toolbelts with slot ids, bank, shop purchases)
 * @param current the method key you're doing now, if any
 * @param fight for the combat toolbelt: { style, gear, owned, bank, area, enemy, food, skill } of the
 *   fight to measure against (the combat page's recommendation)
 * @returns { skills: [{ skill, changes: [{ slot, item, have, replaces, usedUp, measured, set }], gain }],
 *   later: [{ skill, slot, item, needs }] } — later: items you own for slots that aren't open yet, or
 *   that need something more to wear
 */
export function toolbeltAdvice(gd, save, { levels, current = null, fight = null }) {
  const bank = save?.bank?.items ?? {};
  const out = { skills: [], later: [] };
  if (!save?.toolbelts && !save?.bank) return out;
  for (const [skill, slots] of Object.entries(gd.raw.toolbelts ?? {})) {
    const original = (save.toolbelts?.[skill] ?? []).filter((t) => t.slot);
    const measure = (belt) => (skill === 'Combat' ? combatMeasure(gd, save, belt, levels, fight) : skillMeasure(gd, save, skill, belt, levels));
    const fits = (slot) => Object.keys(bank)
      .filter((id) => bank[id] > 0 && gd.items[id]?.tool?.slot === slot.fits && (gd.items[id].tool.effects?.length || gd.items[id].tool.mods?.length || gd.items[id].tool.otherBonuses?.length))
      .sort((a, b) => strength(gd, b) - strength(gd, a) || bank[b] - bank[a]);
    const qtyOf = (id) => (gd.items[id].tool.usedUp ? bank[id] : 1);
    const open = [];
    const closed = [];
    for (const slot of slots) {
      const status = slotStatus(gd, save, slot, levels);
      const owned = fits(slot);
      if (!owned.length) continue;
      if (status.open) open.push({ slot, owned });
      else if (!original.some((t) => t.slot === slot.id)) closed.push({ slot, owned, status });
    }
    const wearLater = [];

    let belt = original;
    let base = measure(belt);
    const unmeasured = new Map(); // slot id -> item, for empty slots where the bonus can't be timed
    // Slot by slot, twice over, so a choice can follow one made after it.
    for (let pass = 0; pass < 2; pass++) {
      for (const { slot, owned } of open) {
        const on = belt.find((t) => t.slot === slot.id);
        let best = null;
        for (const id of owned) {
          if (belt.some((t) => t.item === id && t.slot !== slot.id) || on?.item === id) continue;
          const need = itemNeeds(gd, gd.items[id].tool, levels);
          if (need.length) {
            if (pass === 0 && !wearLater.some((l) => l.item === id)) wearLater.push({ skill, slot, item: id, have: bank[id], needs: need.join(', '), wear: true });
            continue;
          }
          const trial = setBelt(belt, slot.id, id, qtyOf(id));
          const m = measure(trial);
          const c = compare(base, m, current);
          const rank = c.score + (c.scoped?.gain ?? 0) / 1000;
          if (!best || rank > best.rank) best = { id, trial, m, c, rank };
        }
        if (!best) continue;
        const helps = best.c.score >= MIN_SHARE || (!on && best.c.scoped?.gain >= MIN_SHARE && best.c.score > -MIN_SHARE);
        if (helps) {
          belt = best.trial;
          base = best.m;
          unmeasured.delete(slot.id);
        } else if (!on && !belt.some((t) => t.slot === slot.id) && pass === 0) {
          // An empty slot and nothing the companion can time: anything with a bonus beats nothing,
          // as long as it doesn't cost what you can do now.
          const taken = new Set([...belt.map((t) => t.item), ...unmeasured.values()]);
          const harmless = (id) => !base || compare(base, measure(setBelt(belt, slot.id, id, qtyOf(id))), current).score > -MIN_SHARE;
          const pick = owned.find((id) => !taken.has(id) && !itemNeeds(gd, gd.items[id].tool, levels).length && !measurable(gd, skill, id, fight) && harmless(id));
          if (pick) unmeasured.set(slot.id, pick);
        }
      }
    }
    // Sets: their bonus needs several pieces, so a piece on its own can look like nothing.
    for (const set of gd.combat?.sets ?? []) {
      const pieces = set.items.map((id) => ({ id, slot: open.find((o) => gd.items[id]?.tool?.slot === o.slot.fits && (bank[id] > 0 || belt.some((t) => t.item === id)))?.slot })).filter((p) => p.slot && !itemNeeds(gd, gd.items[p.id].tool, levels).length);
      const need = Math.min(...set.bonuses.map((b) => b.count));
      if (pieces.length < need || pieces.every((p) => belt.some((t) => t.item === p.id))) continue;
      let trial = belt;
      for (const p of pieces) trial = setBelt(trial, p.slot.id, p.id, qtyOf(p.id));
      const m = measure(trial);
      if (compare(base, m, current).score >= MIN_SHARE) {
        belt = trial;
        base = m;
        for (const p of pieces) unmeasured.delete(p.slot.id);
      }
    }

    const changes = [];
    for (const { slot, owned } of open) {
      const was = original.find((t) => t.slot === slot.id)?.item ?? null;
      const now = belt.find((t) => t.slot === slot.id)?.item ?? unmeasured.get(slot.id) ?? null;
      if (!now || now === was) continue;
      const set = (gd.combat?.sets ?? []).find((s) => s.items.includes(now) && s.items.filter((i) => belt.some((t) => t.item === i)).length >= Math.min(...s.bonuses.map((b) => b.count)));
      const usedUp = !!gd.items[now].tool.usedUp;
      // A last few of something that gets used up: what to put in after it.
      const then = usedUp && bank[now] < 10 ? owned.find((id) => id !== now && !belt.some((t) => t.item === id) && ![...unmeasured.values()].includes(id)) ?? null : null;
      changes.push({ slot, item: now, have: bank[now], replaces: was, usedUp, measured: !unmeasured.has(slot.id), set: set?.name ?? null, then, thenHave: then ? bank[then] : 0 });
    }
    // Slots that aren't open yet, with something you own for them that isn't going in another slot.
    const used = new Set([...original.map((t) => t.item), ...belt.map((t) => t.item), ...unmeasured.values()]);
    for (const { slot, owned, status } of closed) {
      const pick = owned.find((id) => !used.has(id) && measurable(gd, skill, id, fight)) ?? owned.find((id) => !used.has(id));
      if (!pick) continue;
      used.add(pick);
      out.later.push({ skill, slot, item: pick, have: bank[pick], needs: status.needs, purchase: status.purchase ?? null, unsure: status.open === null });
    }
    out.later.push(...wearLater.filter((l) => !used.has(l.item)));
    if (!changes.length) continue;
    const gain = changes.some((c) => c.measured) ? compare(measure(original), base, current) : null;
    out.skills.push({ skill, changes, gain });
  }
  // Biggest measured gains first, then the ones the companion can't time.
  const worth = (s) => (s.gain ? Math.max(s.gain.score, s.gain.scoped?.gain ?? 0) : -1);
  out.skills.sort((a, b) => worth(b) - worth(a));
  return out;
}

/**
 * Food worth selecting in a skill's own food slot for its bonus (sushi's stealth in Thieving), from
 * the foods in your bank, measured like a toolbelt swap on the skill's best methods.
 * @returns [{ skill, item, have, replaces, gain }]
 */
export function foodAdvice(gd, save, { levels, current = null }) {
  const bank = save?.bank?.items ?? {};
  const skills = new Set(Object.values(gd.items).map((it) => it.foodBonus?.entity).filter((e) => e && e !== 'Combat' && gd.methodsBySkill[e]));
  const out = [];
  for (const skill of skills) {
    const now = save.foods?.[skill] ?? null;
    const measure = (food) => skillMeasure(gd, { ...save, foods: { ...save.foods, [skill]: food } }, skill, (save.toolbelts?.[skill] ?? []).filter((t) => t.slot), levels);
    const base = measure(now);
    let best = null;
    for (const [id, qty] of Object.entries(bank)) {
      if (!(qty > 0) || id === now || gd.items[id]?.foodBonus?.entity !== skill) continue;
      const c = compare(base, measure(id), current);
      if (c.score >= MIN_SHARE && (!best || c.score > best.gain.score)) best = { item: id, gain: c };
    }
    if (best) out.push({ skill, ...best, have: bank[best.item], replaces: now });
  }
  return out.sort((a, b) => b.gain.score - a.gain.score);
}

// How fast a plan step goes: XP for training, the item it's gathering, actions for a Mastery task.
function stepRate(step, r) {
  if (step.kind === 'train') return r.xpPerHour;
  if (step.kind === 'task') return r.cyclesPerHour;
  return r.outputs.find((o) => o.item === step.item)?.perHour ?? 0;
}

/**
 * The toolbelt swaps from your bank that make one plan step go faster: slot by slot, twice over, and
 * skilling sets as a whole.
 * @param step a route step: { kind: 'train'|'task'|'gather'|'make', method, item }
 * @returns null when nothing helps, else { changes: [{ slot, item, have, replaces, usedUp, set }],
 *   gain: how much faster (0.12 = 12%), needed: the step can't be done without them }
 */
export function toolbeltForStep(gd, save, step, { levels }) {
  const skill = step.method.skill;
  const slots = gd.raw.toolbelts?.[skill];
  const bank = save?.bank?.items ?? {};
  if (!slots?.length || !save?.bank) return null;
  const original = (save.toolbelts?.[skill] ?? []).filter((t) => t.slot);
  const rate = (belt) => withBelt(gd, save, skill, belt, (bonuses) => (doable(gd, step.method, levels) ? stepRate(step, computeRates(gd, step.method, gd.levelOf(levels, skill), { bonuses })) : 0));
  const qtyOf = (id) => (gd.items[id].tool.usedUp ? bank[id] : 1);
  const open = slots
    .filter((slot) => slotStatus(gd, save, slot, levels).open)
    .map((slot) => ({ slot, owned: Object.keys(bank).filter((id) => bank[id] > 0 && gd.items[id]?.tool?.slot === slot.fits && !itemNeeds(gd, gd.items[id].tool, levels).length) }))
    .filter((o) => o.owned.length);
  if (!open.length) return null;
  const better = (after, before) => (before > 0 ? after >= before * (1 + MIN_SHARE) : after > 0);

  const start = rate(original);
  let belt = original;
  let base = start;
  // A step that needs tools you have in the bank (a wizard's hat and robes): those go on first, together.
  if (start <= 0) {
    const needs = withBelt(gd, save, skill, belt, () => gd.checkRequirements(step.method, levels).equip);
    for (const r of needs) {
      const o = r.owned.map((t) => ({ id: t.item, slot: open.find((x) => x.owned.includes(t.item))?.slot })).find((x) => x.slot);
      if (o) belt = setBelt(belt, o.slot.id, o.id, qtyOf(o.id));
    }
    base = rate(belt);
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const { slot, owned } of open) {
      let best = null;
      for (const id of owned) {
        if (belt.some((t) => t.item === id)) continue;
        const trial = setBelt(belt, slot.id, id, qtyOf(id));
        const r = rate(trial);
        if (!best || r > best.r) best = { trial, r };
      }
      if (best && better(best.r, base)) {
        belt = best.trial;
        base = best.r;
      }
    }
  }
  for (const set of gd.combat?.sets ?? []) {
    const pieces = set.items.map((id) => ({ id, slot: open.find((o) => o.owned.includes(id) || belt.some((t) => t.item === id && t.slot === o.slot.id))?.slot })).filter((p) => p.slot);
    if (pieces.length < Math.min(...set.bonuses.map((b) => b.count)) || pieces.every((p) => belt.some((t) => t.item === p.id))) continue;
    let trial = belt;
    for (const p of pieces) trial = setBelt(trial, p.slot.id, p.id, qtyOf(p.id));
    const r = rate(trial);
    if (better(r, base)) {
      belt = trial;
      base = r;
    }
  }

  const changes = [];
  for (const { slot } of open) {
    const was = original.find((t) => t.slot === slot.id)?.item ?? null;
    const now = belt.find((t) => t.slot === slot.id)?.item ?? null;
    if (!now || now === was) continue;
    const set = (gd.combat?.sets ?? []).find((s) => s.items.includes(now) && s.items.filter((i) => belt.some((t) => t.item === i)).length >= Math.min(...s.bonuses.map((b) => b.count)));
    changes.push({ slot, item: now, have: bank[now], replaces: was, usedUp: !!gd.items[now].tool.usedUp, set: set?.name ?? null });
  }
  // Nothing changed, or the step still can't be done (it needs a tool you don't have at all).
  if (!changes.length || base <= 0) return null;
  return { changes, gain: start > 0 ? base / start - 1 : null, needed: start <= 0 };
}
