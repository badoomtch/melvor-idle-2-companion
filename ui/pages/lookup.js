// Lookup: items, methods, enemies, areas and shop purchases.
import { GP } from '/engine/gamedata.js';
import { combatLevel, enemyLoot, itemDetails, search, triesFor } from '/engine/lookup.js';
import { computeRates } from '/engine/rates.js';
import { esc, exact, gp, iconImg, num, pct } from '/ui/format.js';
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

function itemPage(ctx, id) {
  const { gd } = ctx;
  const d = itemDetails(gd, id);
  if (!d.info) return card('Not found', '<p class="muted">That item isn\'t in the companion data (it may not be in the demo).</p>');
  const sources = d.sources.map((s) => {
    if (s.type === 'method') return `<li>${methodLink(s.method)} <span class="muted small">${esc(skillName(ctx, s.method.skill))} ${s.method.level}</span></li>`;
    if (s.type === 'enemy') return `<li><a href="#/lookup/enemy/${enc(s.enemy.id)}">${esc(s.enemy.name)}</a> <span class="muted small">${pct(s.chance, s.chance < 0.01 ? 2 : 1)} per kill</span></li>`;
    return `<li><a href="#/lookup/shop/${enc(s.purchase.id)}">${esc(s.purchase.name)}</a> <span class="muted small">Shop</span></li>`;
  });
  const uses = d.uses.map((u) =>
    u.type === 'method'
      ? `<li>${methodLink(u.method)} <span class="muted small">${esc(skillName(ctx, u.method.skill))} ${u.method.level} · uses ${u.qty}</span></li>`
      : `<li><a href="#/lookup/shop/${enc(u.purchase.id)}">${esc(u.purchase.name)}</a> <span class="muted small">Shop cost × ${u.qty}</span></li>`,
  );
  const owned = ctx.bank?.[id];
  return card(`${iconImg(d.info.icon, 'icon lg')}${esc(d.name)}`, `<dl class="kv">
      <dt>Sells for</dt><dd>${d.info.currency === GP ? `${exact(d.info.sell)} GP` : `${exact(d.info.sell)} ${esc(gd.currencyName(d.info.currency))}`}</dd>
      ${d.info.heal ? `<dt>Heals</dt><dd>${d.info.heal} HP</dd>` : ''}
      ${d.info.tags?.length ? `<dt>Type</dt><dd>${esc(d.info.tags.join(', '))}</dd>` : ''}
      ${owned != null ? `<dt>In your bank</dt><dd>${exact(owned)} (${gp(owned * gd.itemValue(id))} GP)</dd>` : ''}
    </dl>
    <div class="detail-body" style="padding-left:0">
      <div><h4>Where to get it</h4>${sources.length ? `<ul>${sources.join('')}</ul>` : '<p class="muted small">No known source in the demo.</p>'}</div>
      <div><h4>What uses it</h4>${uses.length ? `<ul>${uses.join('')}</ul>` : '<p class="muted small">Nothing. Safe to sell unless you want to keep it.</p>'}</div>
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
