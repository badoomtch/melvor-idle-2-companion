// Bank: value, crafts worth doing and safe sells.
import { bankInsights } from '/engine/advisor.js';
import { bankCapacity, freeSpaceOptions } from '/engine/bank-space.js';
import { duration, esc, exact, gp, num } from '/ui/format.js';
import { card, itemLink, methodLink, pageHead, signed, skillName, stat, table } from './shared.js';

// How full the bank is, and the easiest ways to free slots.
function spaceCard(ctx) {
  const cap = bankCapacity(ctx.gd, ctx.save);
  const options = freeSpaceOptions(ctx.gd, ctx.bank, ctx.levels, ctx.save?.bank ?? {}).slice(0, 12);
  const share = cap.max ? cap.used / cap.max : 0;
  // Stacks the game keeps as placeholders when they run out: one note if that's all of them, else per line.
  const emptying = options.filter((o) => o.kind !== 'placeholders');
  const allKept = emptying.length > 0 && emptying.every((o) => o.kept);
  const line = (o) => {
    if (o.kind === 'placeholders') {
      return `<li><div><details class="row-detail"><summary>Remove ${exact(o.slots)} empty placeholder${o.slots === 1 ? '' : 's'} <span class="muted small">slots kept for items you've run out of</span></summary>
        <p class="small">${o.items.map((i) => itemLink(ctx, i)).join(' · ')}</p></details></div><span class="num">${exact(o.slots)} slot${o.slots === 1 ? '' : 's'}</span></li>`;
    }
    const what = o.kind === 'craft'
      ? `Make ${exact(o.crafts)} × ${methodLink(o.method)} <span class="muted small">${esc(skillName(ctx, o.method.skill))} · ${duration(o.hours)}</span>`
      : o.kind === 'sell'
        ? `Sell ${exact(o.qty)} ${itemLink(ctx, o.item)} <span class="muted small">nothing uses it</span>`
        : `Bury ${exact(o.qty)} ${itemLink(ctx, o.item)} <span class="muted small">${num(o.prayerPoints)} prayer points</span>`;
    const kept = o.kept && !allKept ? ' <span class="muted small">then remove its placeholder</span>' : '';
    return `<li><span>${what}${kept}</span><span class="num">${o.slots > 1 ? `${o.slots} slots · ` : ''}${o.kind === 'bury' ? '' : signed(o.gp)}</span></li>`;
  };
  const intro = options.length
    ? `Ways to free slots without losing anything you need, best first. Crafts here use up whole stacks and make something you already have a stack of.${allKept ? ' Your bank keeps a placeholder when a stack runs out, so remove it afterwards to get the slot back.' : ''}`
    : 'Nothing easy to clear: everything left is used by something.';
  return card(`Bank space: ${exact(cap.used)} of ${exact(cap.max)} slots`, `
    <div class="bar${share > 0.9 ? ' warn' : ''}" role="progressbar" aria-label="Bank slots used" aria-valuenow="${Math.round(share * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.min(100, share * 100).toFixed(1)}%"></span></div>
    <p class="small muted">${exact(cap.free)} free. ${intro}</p>
    ${options.length ? `<ul class="list-plain">${options.map(line).join('')}</ul>` : ''}`, ' style="margin-bottom:12px"');
}

// ---------- Bank ----------

export function bank(ctx) {
  const { gd, state } = ctx;
  if (!ctx.bank) {
    return pageHead('Bank') + `<div class="card empty"><h2>No bank data</h2><p>Bank insights need your save. ${ctx.save?.bank?.error ? `The bank couldn't be read: ${esc(ctx.save.bank.error)}` : 'Start the game so it saves, and this page fills in.'}</p></div>`;
  }
  const b = bankInsights(gd, ctx.bank, ctx.levels);
  const filter = state.ui.bankFilter.trim().toLowerCase();
  const shown = b.items.filter((x) => !filter || gd.itemName(x.item).toLowerCase().includes(filter));
  const processing = b.processing.slice(0, 10).map((p) => `<tr><td>Make ${exact(p.crafts)} × ${methodLink(p.method)}<span class="sub">${esc(skillName(ctx, p.method.skill))} ${p.method.level}</span></td><td class="num">${signed(p.gainPerCraft)}</td><td class="num">${signed(p.totalGain)}</td><td class="num">${duration(p.hours)}</td></tr>`);
  const sellable = b.sellable.slice(0, 15).map((x) => `<tr><td>${itemLink(ctx, x.item)}</td><td class="num">${exact(x.qty)}</td><td class="num">${gp(x.total)}</td></tr>`);
  const rows = shown.map((x) => `<tr><td>${itemLink(ctx, x.item)}${x.known ? '' : ' <span class="pill">unknown</span>'}${x.tags.length ? `<span class="sub">${esc(x.tags.join(', '))}</span>` : ''}</td><td class="num">${exact(x.qty)}</td><td class="num">${gp(x.unit)}</td><td class="num">${gp(x.total)}</td></tr>`);
  return `${pageHead('Bank', `${exact(b.items.length)} kinds of item.`)}
    <div class="grid stats">${stat('Bank value', gp(b.total))}${stat('Gold', gp(ctx.save.header.gp))}${stat('Could gain by crafting', gp(b.processing.reduce((s, p) => s + p.totalGain, 0)))}</div>
    <div style="margin-top:12px">${spaceCard(ctx)}</div>
    <h2>Worth more after crafting</h2>
    <p class="small muted">Recipes you can make now from your stock, where the product sells for more than its materials. Each line uses your whole stock, so lines that need the same materials are alternatives, not a to-do list.</p>
    ${table(['Craft', '#Each', '#Total', '#Time'], processing, 'Nothing in your bank gains value from crafting at your levels.')}
    <h2>Nothing uses these</h2>
    <p class="small muted">Nothing in the game data asks for these: no recipe, quest, upgrade, shop, toolbelt or ranch, and you can't wear, eat or open them. Rare finds are left out, since you can't easily get another. A game update could still add a use, so only sell what you're sure about.</p>
    ${table(['Item', '#Qty', '#Value'], sellable, 'Everything in your bank has a use.')}
    <h2>Everything</h2>
    <div class="form-row"><input id="bank-filter" type="search" placeholder="Filter items…" value="${esc(state.ui.bankFilter)}" data-bind="bankFilter" aria-label="Filter items"></div>
    ${table(['Item', '#Qty', '#Each', '#Total'], rows)}`;
}
