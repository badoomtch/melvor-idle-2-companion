// Shop planner: upgrades ranked by how fast they pay for themselves.
import { currentActivity, rankSkill, trainNext } from '/engine/advisor.js';
import { skillGains } from '/engine/history.js';
import { bankCapacity } from '/engine/bank-space.js';
import { buyOrMake } from '/engine/buy-or-make.js';
import { bankSpaceOptions, planShop } from '/engine/shop.js';
import { badge, duration, esc, exact, gp, iconImg, pct } from '/ui/format.js';
import { card, enc, itemLink, levelsKey, memo, methodLink, pageHead, requirementText, skillName, table } from './shared.js';

// ---------- Shop planner ----------

// Skills you've trained in the last week (from history) plus whatever you're doing now.
function trainedSkills(ctx) {
  const { gd, state } = ctx;
  const out = new Set();
  const activity = ctx.save ? currentActivity(gd, ctx.save.header, ctx.levels) : null;
  if (activity?.skill) out.add(activity.skill);
  const h = state.history;
  if (h && h.id === ctx.save?.id) {
    for (const g of skillGains(h.points, { from: Date.now() - 7 * 86_400_000 })) out.add(g.skill);
  }
  for (const [skill, xpPerHour] of Object.entries(ctx.measured ?? {})) if (xpPerHour > 0) out.add(skill);
  return { skills: out, activity };
}

// Things the shop sells that you could also make: which is cheaper, given what your time earns.
export function buyOrMakeRows(ctx) {
  return memo('buyOrMake', levelsKey(ctx), () => {
    const timeValue = trainNext(ctx.gd, ctx.levels, {}, {}).baselineProfit;
    return { timeValue, rows: buyOrMake(ctx.gd, ctx.levels, { timeValue, purchased: ctx.save?.shopPurchases ?? {} }) };
  });
}

function buyOrMakeCard(ctx) {
  const { timeValue, rows } = buyOrMakeRows(ctx);
  if (!rows.length) return '';
  const body = rows.slice(0, 12).map((r) => `<tr>
      <td>${itemLink(ctx, r.item)}<span class="sub">${r.chain.map((m) => esc(m.name)).join(' → ')}</span></td>
      <td class="num">${gp(r.buyEach)}</td>
      <td class="num">${r.makeHoursEach * 3600 < 120 ? `${(r.makeHoursEach * 3600).toFixed(1)}s` : duration(r.makeHoursEach)}</td>
      <td class="num">${gp(r.breakEven)}</td>
      <td><span class="pill ${r.verdict === 'buy' ? 'good' : 'accent'}">${r.verdict === 'buy' ? 'Buy' : 'Make'}</span></td></tr>`);
  return card('Buy or make?', `<p class="small muted">Making it yourself from scratch, counting the time to gather everything, against the shop price. Your time is worth about ${gp(timeValue)} GP/h (your best money maker that needs no materials), so buy anything whose break-even is below that.</p>
    ${table(['Item', '#Price each', '#Make each', '#Break-even GP/h', 'Better'], body)}`, ' style="margin-top:12px"');
}

export function shopPlanner(ctx) {
  const { gd } = ctx;
  const purchased = ctx.save?.shopPurchases ?? {};
  const { skills: trained, activity } = trainedSkills(ctx);
  // The method used for each skill: your current action, or the best XP method at your level.
  const trains = {};
  for (const skill of gd.trainableSkills) {
    const current = activity?.skill === skill && activity.method;
    trains[skill] = current || rankSkill(gd, skill, ctx.levels).best?.method;
  }
  const rows = planShop(gd, { levels: ctx.levels, purchased, trains }).sort((a, b) => (a.paybackHours ?? Infinity) - (b.paybackHours ?? Infinity) || b.gainXp - a.gainXp);
  const yours = rows.filter((r) => trained.has(r.skill));
  const other = rows.filter((r) => !trained.has(r.skill));
  const row = (r) => {
    const others = r.cost.other.map((c) => `${exact(c.qty)} ${esc(gd.currencyName(c.currency))}`).join(', ');
    const gains = [r.gainXp > 0.0005 ? `+${pct(r.gainXp, 1)} XP` : '', r.gainGp > 0.5 ? `${gp(r.gainGp, { signed: true })} GP/h` : ''].filter(Boolean).join(' · ');
    return `<tr><td><a class="with-icon" href="#/lookup/shop/${enc(r.purchase.id)}">${iconImg(r.purchase.icon, 'icon sm')}${esc(r.purchase.name)}</a><span class="sub">${esc(r.purchase.subcategory ?? r.purchase.category ?? '')}</span>${r.unconfirmed?.length ? `<span class="sub warn-text">Also needs: ${esc(r.unconfirmed.map((q) => q.label ?? q.kind).join(', '))}</span>` : ''}</td>
      <td>${badge(r.skill, skillName(ctx, r.skill))} ${methodLink(r.method)}</td>
      <td class="num">${r.cost.gp ? gp(r.cost.gp) : ''}${others ? `<span class="sub">${others}</span>` : ''}</td>
      <td class="num">${gains}</td>
      <td class="num">${r.paybackHours != null ? duration(r.paybackHours) : '–'}</td></tr>`;
  };
  const head = ['Upgrade', 'For', '#Cost', '#Gain', '#Pays back in'];
  const bankRows = bankSpaceOptions(gd, { levels: ctx.levels, purchased }).slice(0, 6).map((b) => `<tr><td><a class="with-icon" href="#/lookup/shop/${enc(b.purchase.id)}">${iconImg(b.purchase.icon, 'icon sm')}${esc(b.purchase.name)}</a><span class="sub">${b.purchase.requires.some((r) => r.type === 'level') ? `Needs ${requirementText(ctx, b.purchase.requires.filter((r) => r.type === 'level'))}` : esc(b.purchase.subcategory ?? '')}</span></td><td class="num">+${exact(b.slots)}</td><td class="num">${gp(b.cost.gp)}</td><td class="num">${gp(b.perSlot)}</td></tr>`);
  const bankUsed = ctx.save?.bank?.stacks;
  const basis = activity?.method ? `${esc(activity.method.name)} for ${esc(skillName(ctx, activity.skill))}, and the best XP method at your level for other skills` : 'the best XP method at your level for each skill';
  return `${pageHead('Shop planner', `Upgrades you can buy now, ranked by how fast the extra GP pays for them. Gains are worked out on ${basis}.${ctx.save ? '' : ' Load a save to skip what you already own.'}`)}
    ${card('For skills you train', table(head, yours.map(row), 'Nothing to buy that helps what you\'re training right now.'))}
    <div class="grid two" style="margin-top:12px;align-items:start">
      ${card('Other skills', table(head, other.slice(0, 15).map(row), 'Nothing else useful to buy right now.'))}
      ${card('Bank space', `${bankUsed != null ? `<p class="small muted">You're using ${exact(bankUsed)} of ${exact(bankCapacity(gd, ctx.save).max)} bank slots. <a href="#/bank">Ways to free some</a></p>` : ''}${table(['Upgrade', '#Slots', '#Cost', '#Per slot'], bankRows, 'No bank space left to buy right now.')}`)}
    </div>
    ${buyOrMakeCard(ctx)}
    <p class="small muted" style="margin-top:10px">Counts doubling, material preservation, step skipping, XP bonuses, rock breaking, tree damage and health, catch and action times, cooking proficiency, stealth and hunting bonuses. Area effects aren't modelled yet. "Pays back in" is hours of that action.</p>`;
}
