// Lookup: items, methods, enemies, areas and shop purchases.
import { GP } from '/engine/gamedata.js';
import { combatLevel, enemyLoot, itemDetails, otherUses, search, triesFor } from '/engine/lookup.js';
import { computeRates } from '/engine/rates.js';
import { duration, esc, exact, gp, iconImg, num, pct } from '/ui/format.js';
import { itemFacts } from './item-info.js';
import { card, enc, itemLink, methodDetail, methodIcon, methodLink, pageHead, requirementText, signed, skillName, stat, table } from './shared.js';

// ---------- Lookup ----------

function lookupResults(ctx) {
  const q = ctx.state.ui.lookupQuery;
  if (q.trim().length < 2) return '<p class="muted">Type at least two letters. Items, training methods, enemies, areas and shop purchases are all searchable.</p>';
  const results = search(ctx.gd, q);
  if (!results.length) return '<p class="muted">No matches.</p>';
  const label = { item: 'Item', method: 'Training', enemy: 'Enemy', area: 'Area', shop: 'Shop' };
  return `<ul class="list-plain">${results
    .map((r) => `<li><a href="#/lookup/${r.type}/${enc(r.id)}">${esc(r.name)}</a><span class="muted small">${label[r.type]}${r.skill ? ` · ${esc(skillName(ctx, r.skill))} ${r.level}` : ''}</span></li>`)
    .join('')}</ul>`;
}

// "Mithril Helmet + 40 Gold Bar + 5,000 GP": what an item upgrade takes.
export const upgradeFrom = (ctx, u) => [...u.costs.items.map((i) => `${i.qty > 1 ? `${exact(i.qty)} ` : ''}${itemLink(ctx, i.item)}`), ...u.costs.currencies.map((c) => `${exact(c.qty)} ${esc(ctx.gd.currencyName(c.currency))}`)].join(' + ');
// "20 Grain every 5 min from 10 Wheat": a Grain Mill batch.
export const millBatch = (ctx, r) => `${exact(r.product.qty)} every ${duration(ctx.gd.raw.grainMill.baseIntervalMs / 3_600_000)} from ${r.ingredients.map((i) => `${exact(i.qty)} ${esc(ctx.gd.itemName(i.item))}`).join(' and ')}`;

// "0.25% per hit (1 in 400)", "every craft": how likely one action is to give the item.
function chanceText(chance, per) {
  if (!(chance > 0)) return '';
  if (chance >= 1) return `every ${per}`;
  const percent = chance * 100;
  const digits = percent >= 1 ? 1 : Math.min(4, Math.ceil(-Math.log10(percent)) + 1);
  return `${pct(chance, digits)} per ${per}${chance < 0.1 ? ` (1 in ${exact(Math.round(1 / chance))})` : ''}`;
}
// Upgrades, the mill and the shop always give the item; sources without a known chance go last.
const sourceChance = (s) => (s.type === 'enemy' || s.type === 'method' ? s.chance ?? -1 : 1);

function itemPage(ctx, id) {
  const { gd } = ctx;
  const d = itemDetails(gd, id);
  if (!d.info) return card('Not found', '<p class="muted">That item isn\'t in the companion data (it may not be in the demo).</p>');
  const needs = (list) => (list.length ? ` · needs ${requirementText(ctx, list)}` : '');
  // Likeliest source first (a stable sort, so ties keep the game data's order).
  const sources = [...d.sources].sort((a, b) => sourceChance(b) - sourceChance(a)).map((s) => {
    if (s.type === 'method') return `<li>${methodLink(s.method)} <span class="muted small">${esc(skillName(ctx, s.method.skill))} ${s.method.level}${s.chance != null ? ` · ${chanceText(s.chance, s.per)}` : ''}</span></li>`;
    if (s.type === 'enemy') return `<li><a class="with-icon" href="#/lookup/enemy/${enc(s.enemy.id)}">${iconImg(s.enemy.icon, 'icon sm')}${esc(s.enemy.name)}</a> <span class="muted small">${chanceText(s.chance, 'kill')}</span></li>`;
    if (s.type === 'upgrade') return `<li>Upgrade from ${upgradeFrom(ctx, s.upgrade)} <span class="muted small">In the bank${s.upgrade.qty > 1 ? ` · makes ${exact(s.upgrade.qty)}` : ''}${needs(s.upgrade.requires)}</span></li>`;
    if (s.type === 'mill') return `<li>${esc(gd.raw.grainMill.name)}: ${esc(s.recipe.name)} <span class="muted small">${millBatch(ctx, s.recipe)}${needs(s.recipe.requires)}</span></li>`;
    return `<li><a href="#/lookup/shop/${enc(s.purchase.id)}">${esc(s.purchase.name)}</a> <span class="muted small">Shop</span></li>`;
  });
  const uses = d.uses.map((u) => {
    if (u.type === 'method') return `<li>${methodLink(u.method)} <span class="muted small">${esc(skillName(ctx, u.method.skill))} ${u.method.level} · uses ${u.qty}</span></li>`;
    if (u.type === 'upgrade') return `<li>Upgrade into ${itemLink(ctx, u.upgrade.item)} <span class="muted small">In the bank · uses ${exact(u.qty)}</span></li>`;
    if (u.type === 'mill') return `<li>${esc(gd.raw.grainMill.name)}: ${esc(u.recipe.name)} <span class="muted small">${exact(u.qty)} a batch</span></li>`;
    return `<li><a href="#/lookup/shop/${enc(u.purchase.id)}">${esc(u.purchase.name)}</a> <span class="muted small">Shop cost × ${u.qty}</span></li>`;
  });
  // What it is and every other place the game asks for it (keys, quests, the ranch, bait, runes...).
  const covered = new Set(d.uses.filter((u) => u.type === 'method').map((u) => u.method.name));
  const other = otherUses(gd, id, covered).map((t) => `<li>${esc(t)}</li>`);
  const owned = ctx.bank?.[id];
  return card(`${iconImg(d.info.icon, 'icon lg')}${esc(d.name)}`, `<dl class="kv">
      <dt>Sells for</dt><dd>${d.info.currency === GP ? `${exact(d.info.sell)} GP` : `${exact(d.info.sell)} ${esc(gd.currencyName(d.info.currency))}`}</dd>
      ${d.info.heal ? `<dt>Heals</dt><dd>${d.info.heal} HP</dd>` : ''}
      ${d.info.tags?.length ? `<dt>Type</dt><dd>${esc(d.info.tags.join(', '))}</dd>` : ''}
      ${owned != null ? `<dt>In your bank</dt><dd>${exact(owned)} (${gp(owned * gd.itemValue(id))} GP)</dd>` : ''}
    </dl>
    ${(() => {
      const facts = itemFacts(ctx, id);
      return facts.length ? `<h4 style="margin-top:12px">What it does</h4><ul class="hover-facts">${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '';
    })()}
    <div class="detail-body" style="padding-left:0">
      <div><h4>Where to get it</h4>${sources.length ? `<ul>${sources.join('')}</ul>` : '<p class="muted small">No known source in the demo.</p>'}</div>
      <div><h4>What uses it</h4>${uses.length || other.length ? `<ul>${[...other, ...uses].join('')}</ul>` : `<p class="muted small">${/\(c\)$/.test(d.name) ? 'A collectable. ' : ''}Nothing in the game data uses it: no recipe, quest, upgrade, shop, toolbelt or ranch needs it, and you can't wear, eat or open it. A game update could still add a use.</p>`}</div>
    </div>`);
}

function methodPage(ctx, key) {
  const { gd } = ctx;
  const m = gd.methodByKey.get(key);
  if (!m) return card('Not found', '<p class="muted">Unknown training method.</p>');
  const level = Math.max(ctx.levels[m.skill] ?? 1, m.level);
  const req = gd.checkRequirements(m, ctx.levels);
  const r = computeRates(gd, m, level);
  return card(`${methodIcon(gd, m, 'icon lg')}${esc(m.name)}`, `<p class="muted">${esc(skillName(ctx, m.skill))} level ${m.level}${m.category ? ` · ${esc(m.category)}` : ''}${req.ok ? '' : ' · <span class="pill">not unlocked yet</span>'}</p>
    <div class="grid stats">${stat('XP / hour', num(r.xpPerHour))}${stat('Profit / hour', signed(r.profitPerHour))}${r.successChance != null ? stat('Success', pct(r.successChance, 1)) : ''}</div>
    <p class="small muted" style="margin-top:8px">At level ${level}. <a href="#/skills/${m.skill}">Compare with other ${esc(skillName(ctx, m.skill))} methods</a></p>
    ${methodDetail(ctx, { method: m, rates: r, ...req })}`);
}

function enemyPage(ctx, id) {
  const e = ctx.gd.enemyById.get(id);
  if (!e) return card('Not found', '<p class="muted">Unknown enemy.</p>');
  const loot = enemyLoot(ctx.gd, e);
  const drops = loot.items.map((d) => `<tr><td>${itemLink(ctx, d.item)}</td><td class="num">${pct(d.chance, d.chance < 0.01 ? 2 : 1)}</td><td class="num">${exact(triesFor(d.chance, 0.5))}</td><td class="num">${gp(d.value)}</td></tr>`);
  const areas = e.areas.map((a) => ctx.gd.areaById.get(a)).filter(Boolean).map((a) => `<a href="#/lookup/area/${enc(a.id)}">${esc(a.name)}</a>`).join(', ');
  return card(`${iconImg(e.icon, 'icon lg')}${esc(e.name)}`, `<p class="muted">${areas || 'No area'} · ${Object.entries(e.levels).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</p>
    <div class="grid stats">${stat('GP per kill', gp(loot.gp))}${stat('Loot value per kill', gp(loot.totalValue))}</div>
    <h2>Drops</h2>${table(['Item', '#Per kill', '#Kills for 50%', '#Value / kill'], drops)}`);
}

function areaPage(ctx, id) {
  const a = ctx.gd.areaById.get(id);
  if (!a) return card('Not found', '<p class="muted">Unknown area.</p>');
  const enemies = a.enemies.map((eid) => ctx.gd.enemyById.get(eid)).filter(Boolean).map((e) => `<li><a href="#/lookup/enemy/${enc(e.id)}">${esc(e.name)}</a> <span class="muted small">level ${combatLevel(e, ctx.gd)} · ${gp(enemyLoot(ctx.gd, e).totalValue)} loot/kill</span></li>`);
  return card(esc(a.name), `<p class="muted">${a.kind === 'dungeon' ? 'Dungeon' : 'Combat area'}${a.difficulty ? ` · ${esc(a.difficulty)}` : ''}${a.requires.length ? ` · Requires ${requirementText(ctx, a.requires)}` : ''}</p><ul>${enemies.join('')}</ul>`);
}

function shopPage(ctx, id) {
  const s = ctx.gd.shopById.get(id);
  if (!s) return card('Not found', '<p class="muted">Unknown shop purchase.</p>');
  const costs = [...s.costs.currencies.map((c) => `${exact(c.qty)} ${esc(ctx.gd.currencyName(c.currency))}`), ...s.costs.items.map((i) => `${exact(i.qty)} × ${itemLink(ctx, i.item)}`)];
  const gives = [...s.provides.bonuses.map(esc), ...s.provides.items.map((i) => `${exact(i.qty)} × ${itemLink(ctx, i.item)}`), ...s.provides.currencies.map((c) => `${exact(c.qty)} ${esc(ctx.gd.currencyName(c.currency))}`)];
  return card(`${iconImg(s.icon, 'icon lg')}${esc(s.name)}`, `${s.description ? `<p>${esc(s.description)}</p>` : ''}<dl class="kv">
      <dt>Shop</dt><dd>${esc([s.category, s.subcategory].filter(Boolean).join(' › '))}</dd>
      <dt>Costs</dt><dd>${costs.join(', ') || 'Free'}</dd>
      <dt>Gives</dt><dd>${gives.join(', ') || '–'}</dd>
      <dt>Requires</dt><dd>${s.requires.length ? requirementText(ctx, s.requires) : 'Nothing'}</dd>
      <dt>Buy limit</dt><dd>${s.buyLimit > 0 ? s.buyLimit : 'Unlimited'}</dd>
    </dl>`);
}

export function lookupView(ctx, [type, id]) {
  const decoded = id ? decodeURIComponent(id) : null;
  const pages = { item: itemPage, method: methodPage, enemy: enemyPage, area: areaPage, shop: shopPage };
  const detail = type && pages[type] && decoded ? pages[type](ctx, decoded) : '';
  return `${pageHead('Lookup', 'Where things come from, what uses them, and what they\'re worth.')}
    <div class="form-row"><input id="lookup-q" type="search" placeholder="Search items, methods, enemies…" value="${esc(ctx.state.ui.lookupQuery)}" data-bind="lookupQuery" aria-label="Search" autocomplete="off"></div>
    <div class="grid two" style="align-items:start">${card('', lookupResults(ctx))}${detail || card('', '<p class="muted">Pick a result to see its details.</p>')}</div>`;
}
