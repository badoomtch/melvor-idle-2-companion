// Completion: completion log progress and the quickest gaps to fill.
import { fight, STYLES } from '/engine/combat.js';
import { completionStatus } from '/engine/completion.js';
import { bestFightsByEnemy } from '/engine/slayer.js';
import { badge, duration, esc, exact, iconImg, pct } from '/ui/format.js';
import { combatRecommendation, STYLE_SKILL } from './combat.js';
import { millBatch, upgradeFrom } from './lookup.js';
import { card, enc, gatherStep, itemLink, memo, methodLink, noSaveCard, pageHead, saveKey, skillName, stat, table } from './shared.js';

// ---------- Completion ----------

export function completion(ctx) {
  const { gd } = ctx;
  const head = pageHead('Completion', 'Your completion log, and the quickest way to fill each gap with what you can do now.');
  if (!ctx.save) return `${head}${noSaveCard(ctx)}`;
  if (!ctx.save.itemsFound) return `${head}<p class="notice warn">This save doesn't have the completion statistics the companion reads.</p>`;
  const st = memo('completion', saveKey(ctx), () => {
    const best = gd.combat && ctx.save.combat && ctx.bank ? bestFightsByEnemy(STYLES.map((style) => combatRecommendation(ctx, style))) : null;
    return completionStatus(gd, { save: ctx.save, levels: ctx.levels, bestFights: best, stock: ctx.stock });
  });
  const part = (label, p) => stat(label, `${exact(p.done)} <span class="muted small">/ ${exact(p.total)} · ${pct(p.total ? p.done / p.total : 0)}</span>`);
  const how = (b) => {
    if (b.type === 'shop') {
      const costs = b.purchase.costs.currencies.map((c) => `${exact(c.qty)} ${esc(gd.currencyName(c.currency))}`).concat(b.purchase.costs.items.map((i) => `${exact(i.qty)} ${esc(gd.itemName(i.item))}`));
      return `Buy <a href="#/lookup/shop/${enc(b.purchase.id)}">${esc(b.purchase.name)}</a> <span class="muted small">${costs.join(', ') || 'free'}</span>`;
    }
    if (b.type === 'enemy') return `Kill ${iconImg(b.enemy.icon, 'icon sm')}<a href="#/lookup/enemy/${enc(b.enemy.id)}">${esc(b.enemy.name)}</a> <span class="muted small">${pct(b.chance, b.chance < 0.01 ? 2 : 1)} drop · ~${exact(b.kills)} kills for 50%</span>`;
    // Materials you're short of: the whole chain, in the order to do it.
    const first = (b.gather ?? []).map((g) => [...g.needs, g].map((n) => gatherStep(ctx, n)).join(' → '));
    const then = first.map((c) => `<span class="sub small warn-text">First ${c}</span>`).join('');
    if (b.type === 'upgrade') return `Upgrade from ${upgradeFrom(ctx, b.upgrade)} <span class="muted small">in the bank</span>${then}`;
    if (b.type === 'mill') return `${esc(gd.raw.grainMill.name)}: ${esc(b.recipe.name)} <span class="muted small">${millBatch(ctx, b.recipe)}</span>${then}`;
    return `${methodLink(b.method)} <span class="muted small">${esc(skillName(ctx, b.method.skill))}</span>${then}`;
  };
  const time = (h) => (h === 0 ? 'Now' : h < 1 / 60 ? '< 1 min' : duration(h));
  const itemRows = st.nextItems.slice(0, 25).map((x) => `<tr><td>${itemLink(ctx, x.item)}</td><td>${how(x.best)}</td><td class="num">${time(x.best.hours)}${x.best.gatherHours >= 1 / 60 ? `<span class="sub muted small">${duration(x.best.gatherHours)} gathering</span>` : ''}</td></tr>`);
  const enemyRows = st.nextEnemies.slice(0, 20).map(({ enemy, fight }) => {
    const area = enemy.areas.map((a) => gd.areaById.get(a)?.name).filter(Boolean)[0] ?? '';
    const note = !fight ? '<span class="pill">Area not open to you yet</span>' : fight.result.risky ? '<span class="pill bad">Could kill you</span>' : `${badge(STYLE_SKILL[fight.style], fight.style)} ${fight.style} · ${fight.result.killSeconds.toFixed(fight.result.killSeconds < 10 ? 1 : 0)}s a kill`;
    return `<tr><td>${iconImg(enemy.icon, 'icon sm')}<a href="#/lookup/enemy/${enc(enemy.id)}">${esc(enemy.name)}</a><span class="sub">${esc(area)}</span></td><td>${note}</td></tr>`;
  });
  const blocked = st.items.missing.length - st.nextItems.length;
  return `${head}
    <div class="grid stats">${part('Items found', st.items)}${part('Enemies killed', st.enemies)}${part('Pets found', st.pets)}${part('Skill levels', st.levels)}</div>
    <div class="grid two" style="margin-top:12px;align-items:start">
      ${card('Quickest items to find next', `${table(['Item', 'How', '#Time'], itemRows, 'Nothing you can get right now.')}<p class="small muted" style="margin-top:8px">${exact(st.nextItems.length)} missing items are within reach now; ${exact(blocked)} need higher levels, quests, gear, gold or shop unlocks first. Times include gathering any materials you're short of, for crafting and for upgrades in the bank; drop times are for a 50% chance.</p>`)}
      ${card('Enemies you haven\'t killed', `${table(['Enemy', 'With your best gear'], enemyRows, 'You\'ve killed everything. Wow.')}<p class="small muted" style="margin-top:8px">${exact(st.enemies.missing.length)} left, quickest first.</p>`)}
    </div>`;
}
