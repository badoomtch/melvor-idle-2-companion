// What an item is and does, from its own data: its gear stats and requirements, toolbelt effects,
// food, and how much you have. Shared by the Lookup page and the card that shows when you point at an item.
import { otherUses } from '/engine/lookup.js';
import { esc, exact, gp, iconImg } from '/ui/format.js';
import { bonusText } from './combat.js';
import { requirementText, skillName } from './shared.js';

// Attack and defence bonuses, by style and attack type (the game's names for them).
const STYLE_TYPES = [
  ['Melee', [['Stab', 'Stab'], ['Slash', 'Slash'], ['Crush', 'Crush'], ['Block', 'Block']]],
  ['Ranged', [['Accurate', 'Accurate'], ['Powerful', 'Powerful'], ['LongRange', 'Long range']]],
  ['Magic', [['Offensive', 'Offensive'], ['Defensive', 'Defensive']]],
];
const signed = (v) => `${v > 0 ? '+' : ''}${exact(v)}`;
const humanize = (s) => String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');

// "Melee attack: crush +121" and so on, only the ones it has.
function bonusLines(stats) {
  const lines = [];
  for (const [style, types] of STYLE_TYPES) {
    for (const side of ['Attack', 'Defence']) {
      const parts = types.map(([id, name]) => [name, stats[`${id}${side}Bonus`] ?? 0]).filter(([, v]) => v);
      if (parts.length) lines.push(`${style} ${side.toLowerCase()}: ${parts.map(([n, v]) => `${n.toLowerCase()} ${signed(v)}`).join(', ')}`);
    }
  }
  if (stats.MeleeStrengthBonus) lines.push(`Melee strength ${signed(stats.MeleeStrengthBonus)}`);
  if (stats.RangedStrengthBonus) lines.push(`Ranged strength ${signed(stats.RangedStrengthBonus)}`);
  if (stats.MagicDamageBonus) lines.push(`Magic damage ${signed(stats.MagicDamageBonus)}%`);
  if (stats.AttackInterval) lines.push(`Attacks every ${(stats.AttackInterval / 1000).toFixed(1)}s`);
  return lines;
}

/**
 * The facts about an item, as short lines: what it is, its stats, what it needs.
 * @param short fewer lines, for the card when you point at an item
 */
export function itemFacts(ctx, id, { short = false } = {}) {
  const { gd } = ctx;
  const it = gd.items[id];
  if (!it) return [];
  const lines = [];
  const eq = it.equip;
  if (eq) {
    const two = eq.alsoOccupies?.includes('Offhand') ? ', two-handed' : '';
    const weapon = eq.weapon ? ` (${humanize(eq.weapon.type).toLowerCase()}${eq.weapon.ammo ? `, uses ${humanize(eq.weapon.ammo).toLowerCase()}` : ''})` : '';
    lines.push(`${humanize(eq.type)}${weapon}${two}`);
    if (eq.power || eq.protection) lines.push([eq.power ? `Power ${exact(eq.power)}` : '', eq.protection ? `Protection ${exact(eq.protection)}` : ''].filter(Boolean).join(' · '));
    const bonuses = bonusLines(eq.stats ?? {});
    lines.push(...(short ? bonuses.filter((l) => !/defence:/.test(l)).slice(0, 3) : bonuses));
    const extra = bonusText(eq.mods ?? []);
    if (extra) lines.push(extra[0].toUpperCase() + extra.slice(1));
    for (const o of eq.otherBonuses ?? []) if (!short) lines.push(o);
    if (eq.requires?.length) lines.push(`Needs ${requirementText(ctx, eq.requires)}`);
  }
  if (it.tool) {
    lines.push(`Toolbelt: ${humanize(it.tool.slot)}${it.tool.usedUp ? ', used up as you go' : ''}`);
    for (const o of (it.tool.otherBonuses ?? []).slice(0, short ? 3 : 20)) lines.push(o);
    if (it.tool.requires?.length) lines.push(`Needs ${requirementText(ctx, it.tool.requires)}`);
  }
  if (it.heal) lines.push(`Heals ${exact(it.heal)} HP${it.foodBonus ? `, and while it's selected for ${esc(skillName(ctx, it.foodBonus.entity))}: ${it.foodBonus.effects.map((e) => `${humanize(e.stat).toLowerCase()} ${signed(e.value)}`).join(', ')}` : ''}`);
  if (it.prayerPoints) lines.push(`Bury for ${exact(it.prayerPoints)} prayer points`);
  return lines.filter(Boolean);
}

// The card shown when you point at an item: picture, name, what it is, what it's worth, how many you have,
// and what uses it.
export function itemCard(ctx, id) {
  const { gd } = ctx;
  const it = gd.items[id];
  if (!it) return '';
  const facts = itemFacts(ctx, id, { short: true });
  const uses = otherUses(gd, id).filter((u) => !/^Worn|^Goes in a toolbelt|^Food/.test(u)).slice(0, 2);
  const have = ctx.stock?.[id] ?? ctx.bank?.[id];
  return `<div class="hover-head">${iconImg(it.icon, 'icon md')}<strong>${esc(it.name)}</strong></div>
    ${facts.length ? `<ul class="hover-facts">${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    ${uses.length ? `<p class="small muted">${esc(uses.join(' · '))}</p>` : ''}
    <p class="small muted">Sells for ${exact(it.sell)} ${it.currency === 'GoldPieces' ? 'GP' : esc(gd.currencyName(it.currency))}${have ? ` · you have ${exact(have)} (${gp(have * gd.itemValue(id))} GP)` : ''}</p>`;
}
