// The Toolbelts page: items in your bank worth putting on, and what's in each toolbelt now.
import { foodAdvice, slotStatus, toolbeltAdvice } from '/engine/toolbelt-advice.js';
import { badge, esc, exact, gp, iconImg, pct } from '/ui/format.js';
import { combatRecommendation, combatSetup } from './combat.js';
import { bonusText, card, itemLink, memo, methodLink, pageHead, saveKey, skillName } from './shared.js';
import { currentMethodKey } from './route-ui.js';

const MIN_SHARE = 0.005;

// Combat's toolbelt isn't a skill: its own icon, and a link to the Combat page.
const skillBadge = (ctx, skill) => (skill === 'Combat' ? iconImg('res://Assets/Icons/Combat_64.png', 'icon sm') : badge(skill, skillName(ctx, skill)));
const skillHref = (skill) => (skill === 'Combat' ? '#/combat' : `#/skills/${skill}`);

// What a toolbelt item does, in words.
const toolText = (tool) => [...(tool.effects ?? []).map(bonusText), ...(tool.mods ?? []).map(bonusText)].join(', ') || (tool.otherBonuses ?? []).join(', ');

// The fight the combat toolbelt is measured on: the combat page's pick for the style you're set up for.
function fightFor(ctx) {
  if (!ctx.gd.combat || !ctx.save?.combat || !ctx.bank) return null;
  const { currentStyle, owned, food } = combatSetup(ctx);
  const rec = combatRecommendation(ctx, currentStyle);
  return rec?.gear?.enemy ? { style: currentStyle, gear: rec.gear.gear, owned, bank: ctx.bank, area: rec.gear.area, enemy: rec.gear.enemy, food } : null;
}

export function toolbeltAdviceFor(ctx) {
  if (!ctx.save?.bank || ctx.state.levelSource !== 'save' || !ctx.gd.raw.toolbelts) return null;
  return memo('toolbelt:advice', saveKey(ctx), () => toolbeltAdvice(ctx.gd, ctx.save, { levels: ctx.levels, current: currentMethodKey(ctx), fight: fightFor(ctx) }));
}

// What the changes are worth: the lines worth saying, biggest first.
function gainLines(ctx, s, fight) {
  const g = s.gain;
  if (!g) {
    return [s.changes.length === 1
      ? '<span class="muted">The companion can\'t put a number on this bonus, but the slot is empty, so it can only help.</span>'
      : '<span class="muted">The companion can\'t put a number on these bonuses, but the slots are empty, so they can only help.</span>'];
  }
  const skill = esc(skillName(ctx, s.skill));
  const lines = [];
  if (g.combatXp != null) {
    if (g.combatXp >= MIN_SHARE) lines.push(`+${pct(g.combatXp, 1)} combat XP/h against ${esc(fight?.enemy?.name ?? 'your best fight')}`);
    if (g.damageCut >= 0.05) lines.push(`${pct(g.damageCut)} less damage taken, so less food`);
    return lines;
  }
  if (g.current && (g.current.xp >= MIN_SHARE || g.current.gp >= MIN_SHARE)) {
    lines.push(`+${pct(Math.max(g.current.xp, g.current.gp), 1)} ${g.current.xp >= g.current.gp ? 'XP' : 'GP'}/h on what you're doing now, ${methodLink(g.current.method)}`);
  }
  if (g.xp.share >= MIN_SHARE) lines.push(`+${pct(g.xp.share, 1)} XP/h on your fastest ${skill} training, ${methodLink(g.xp.method)}`);
  if (g.gp.share >= MIN_SHARE && g.gp.perHour > 0) lines.push(`+${gp(g.gp.perHour)} GP/h on your best ${skill} money maker, ${methodLink(g.gp.method)}`);
  if (!lines.length && g.scoped) {
    const sc = g.scoped;
    const what = sc.xp >= sc.gross && sc.xp >= sc.cost ? `+${pct(sc.xp, 1)} XP/h` : sc.gross >= sc.cost ? `+${pct(sc.gross, 1)} more made` : `${pct(sc.cost, 1)} less spent on materials`;
    lines.push(`Helps with ${methodLink(sc.method)} only: ${what}`);
  }
  const lostBy = s.changes.filter((c) => c.replaces).map((c) => itemLink(ctx, c.replaces));
  if (g.lost?.length && lostBy.length) lines.push(`<span class="warn-text">Put ${lostBy.join(' and ')} back on to do ${g.lost.slice(0, 3).map(methodLink).join(', ')}${g.lost.length > 3 ? ` and ${g.lost.length - 3} more` : ''}</span>`);
  return lines;
}

// One change: the slot, what goes in it and what it does.
function changeLine(ctx, c) {
  const tool = ctx.gd.items[c.item].tool;
  const where = c.replaces ? `instead of ${itemLink(ctx, c.replaces)}` : '<span class="muted">empty now</span>';
  const notes = [
    toolText(tool) && esc(toolText(tool)),
    c.usedUp ? `used up as you go · you have ${exact(c.have)}` : '',
    c.then ? `then ${itemLink(ctx, c.then)} (you have ${exact(c.thenHave)})` : '',
  ].filter(Boolean);
  return `<li><span><span class="muted small">${esc(c.slot.name)}:</span> ${itemLink(ctx, c.item)} <span class="small">${where}</span>${c.set ? ` <span class="pill accent">${esc(c.set)}</span>` : ''}
    <span class="sub muted small">${notes.join(' · ')}</span></span></li>`;
}

function laterLine(ctx, l) {
  const p = l.purchase && ctx.gd.shopById.get(l.purchase);
  const cost = p ? ` (${[...p.costs.currencies.map((c) => `${exact(c.qty)} ${esc(ctx.gd.currencyName(c.currency))}`), ...p.costs.items.map((i) => `${exact(i.qty)} ${esc(ctx.gd.itemName(i.item))}`)].join(', ')})` : '';
  const when = l.unsure ? `if you've opened it (${esc(l.needs)})` : `once you ${esc(l.needs.charAt(0).toLowerCase() + l.needs.slice(1))}${cost}`;
  return `<li><span>${skillBadge(ctx, l.skill)} ${esc(l.slot.name)}: ${itemLink(ctx, l.item)} <span class="muted small">you have ${exact(l.have)}</span>
    <span class="sub muted small">${l.wear ? `Needs ${esc(l.needs)} to wear` : `Goes in ${when}`}</span></span></li>`;
}

// What's in every skill's toolbelt now, slot by slot, and what opens the slots that are still shut.
function nowCard(ctx) {
  const { gd, save } = ctx;
  const blocks = Object.entries(gd.raw.toolbelts).map(([skill, slots]) => {
    const on = save.toolbelts?.[skill] ?? [];
    // "Cooking Utility 2" reads as "Utility 2" under the Cooking heading.
    const short = (slot) => esc(slot.name.replace(new RegExp(`^${skillName(ctx, skill)} `), ''));
    const worn = [];
    const empty = [];
    const shut = [];
    for (const slot of slots) {
      const t = on.find((x) => x.slot === slot.id);
      if (t) {
        worn.push(`<span class="muted small">${short(slot)}:</span> ${itemLink(ctx, t.item)}${gd.items[t.item]?.tool?.usedUp ? ` <span class="muted small">× ${exact(t.qty)}</span>` : ''}`);
        continue;
      }
      const status = slotStatus(gd, save, slot, ctx.levels);
      if (status.open) empty.push(short(slot));
      else shut.push(`${short(slot)} opens once you ${esc(status.needs.charAt(0).toLowerCase() + status.needs.slice(1))}${status.open === null ? " (your save doesn't show whether you have)" : ''}`);
    }
    const lines = [
      worn.length ? `<span class="sub small">${worn.join(' · ')}</span>` : '',
      empty.length ? `<span class="sub muted small">Empty: ${empty.join(', ')}</span>` : '',
      ...shut.map((s) => `<span class="sub muted small">${s}</span>`),
    ];
    return `<li class="belt-skill"><span>${skillBadge(ctx, skill)} <a href="${skillHref(skill)}"><strong>${esc(skillName(ctx, skill))}</strong></a>${lines.join('')}</span></li>`;
  });
  return card('In your toolbelts now', `<ul class="list-plain">${blocks.join('')}</ul>`, ' style="margin-top:12px"');
}

// The Toolbelts page: what to put on from your bank, what's waiting for a slot to open, and what's on now.
export function toolbeltPage(ctx) {
  const head = pageHead('Toolbelts', 'What to put in each skill\'s toolbelt from your bank. Your plan on What next also says when a swap makes a step quicker.');
  const advice = toolbeltAdviceFor(ctx);
  if (!advice) return `${head}<div class="card empty"><h2>No save loaded</h2><p>Toolbelt suggestions come from your save: what's in your bank and in your toolbelts.</p></div>`;
  const fight = advice.skills.some((s) => s.skill === 'Combat') ? fightFor(ctx) : null;
  const blocks = advice.skills.map((s) => `<li class="belt-skill"><span>${skillBadge(ctx, s.skill)} <a href="${skillHref(s.skill)}"><strong>${esc(skillName(ctx, s.skill))}</strong></a> toolbelt
      <ul class="list-plain belt-changes">${s.changes.map((c) => changeLine(ctx, c)).join('')}</ul>
      ${gainLines(ctx, s, fight).map((l) => `<span class="sub small accent-text">${l}</span>`).join('')}</span></li>`);
  const intro = '<p class="small muted">Items sitting in your bank that would do something in a skill\'s toolbelt: empty slots first, or something better than what\'s there. Measured on that skill\'s best methods at your levels and on what you\'re doing now.</p>';
  const swaps = card('Put these on', blocks.length ? `${intro}<ul class="list-plain">${blocks.join('')}</ul>` : '<p class="muted small">Nothing in your bank beats what\'s in your toolbelts.</p>');
  const later = advice.later.length
    ? card(`For later <span class="muted small">· ${exact(advice.later.length)}</span>`, `<p class="small muted">Items you own for slots that aren't open yet, or that need a level first.</p><ul class="list-plain">${advice.later.map((l) => laterLine(ctx, l)).join('')}</ul>`, ' style="margin-top:12px"')
    : '';
  return `${head}${swaps}${foodCard(ctx)}${later}${nowCard(ctx)}`;
}

// Food with a bonus for a skill (sushi's stealth for Thieving), selected in that skill's own food slot.
function foodCard(ctx) {
  const advice = memo('toolbelt:food', saveKey(ctx), () => foodAdvice(ctx.gd, ctx.save, { levels: ctx.levels, current: currentMethodKey(ctx) }));
  if (!advice.length) return '';
  const rows = advice.map((f) => {
    const bonus = esc(ctx.gd.items[f.item].foodBonus.effects.map(bonusText).join(', '));
    return `<li class="belt-skill"><span>${skillBadge(ctx, f.skill)} <a href="${skillHref(f.skill)}"><strong>${esc(skillName(ctx, f.skill))}</strong></a> food: ${itemLink(ctx, f.item)} <span class="small">${f.replaces ? `instead of ${itemLink(ctx, f.replaces)}` : '<span class="muted">none selected</span>'}</span>
      <span class="sub muted small">${bonus} · you have ${exact(f.have)}</span>
      ${gainLines(ctx, { skill: f.skill, changes: [], gain: f.gain }, null).map((l) => `<span class="sub small accent-text">${l}</span>`).join('')}</span></li>`;
  });
  return card('Food for your skills', `<p class="small muted">Some foods help a skill while they're selected in that skill's own food slot, as long as you have some.</p><ul class="list-plain">${rows.join('')}</ul>`, ' style="margin-top:12px"');
}
