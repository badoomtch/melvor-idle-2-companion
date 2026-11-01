// What next?: quickest unlocks and money upgrades, counting only what you own.
import { bankInsights, bestMoney, currentActivity, trainNext } from '/engine/advisor.js';
import { describeRequirement } from '/engine/gamedata.js';
import { badge, duration, esc, exact, gp } from '/ui/format.js';
import { card, gatherStep, itemLink, memo, methodLink, pageHead, requirementText, saveKey, signed, skillName } from './shared.js';
import { masteryPlanFor, rankRow, ranksWorthGetting } from './mastery-ui.js';
import { currentMethodKey, routeCard } from './route-ui.js';
import { buyOrMakeRows } from './shop.js';

// ---------- What next? ----------

// How a training plan gets there: the method, what it takes from your bank, and what to gather first.
export function planNote(ctx, plan) {
  if (!plan?.steps.length) return '';
  const { gd } = ctx;
  const methods = plan.steps.map((st) => st.method).filter((m, i, all) => all.findIndex((x) => x.key === m.key) === i);
  const lines = [`Train: ${methods.slice(0, 2).map(methodLink).join(' → ')}${methods.length > 2 ? ` → +${methods.length - 2} more` : ''}`];
  const equip = methods.flatMap((m) => gd.checkRequirements(m, ctx.levels).equip);
  if (equip.length) lines.push(`<span class="accent-text">${requirementText(ctx, equip.filter((r, i) => equip.findIndex((q) => describeRequirement(gd, q) === describeRequirement(gd, r)) === i))} first</span>`);
  if (ctx.bank) {
    const used = plan.uses.filter((u) => u.qty >= 0.5).sort((a, b) => b.qty / b.have - a.qty / a.have);
    if (used.length) {
      const all = used.map((u) => `${exact(Math.ceil(u.qty))} of ${exact(u.have)} ${gd.itemName(u.item)}`).join(', ');
      lines.push(`<span title="${esc(`From your bank: ${all}`)}">Uses ${used.slice(0, 2).map((u) => `${exact(Math.ceil(u.qty))}/${exact(u.have)} ${itemLink(ctx, u.item)}`).join(', ')}${used.length > 2 ? ` +${used.length - 2} more` : ''}</span>`);
    }
    for (const g of plan.gather) {
      // The whole chain, in the order to do it: e.g. mine the ore, then smelt the bar.
      const chain = [...g.needs, g].map((n) => gatherStep(ctx, n)).join(' → ');
      const offer = buyOrMakeRows(ctx).rows.find((r) => r.item === g.item && r.verdict === 'buy');
      const buy = offer ? ` (or buy for ${gp(offer.buyEach * Math.ceil(g.qty))} GP)` : '';
      lines.push(g.method
        ? `<span class="warn-text">Short ${exact(Math.ceil(g.qty))} ${itemLink(ctx, g.item)}: first ${chain}${buy}</span>`
        : `<span class="warn-text">Needs ${exact(Math.ceil(g.qty))} ${itemLink(ctx, g.item)} you don't have, and nothing you can do yet makes it</span>`);
    }
  }
  return lines.map((l) => `<span class="sub muted small">${l}</span>`).join('');
}

const planTime = (plan) => (plan?.gatherHours >= 1 / 60
  ? `<span class="num" title="${esc(`${duration(plan.trainHours)} training + ${duration(plan.gatherHours)} gathering`)}">${duration(plan.hours)}<span class="sub muted small">${duration(plan.gatherHours)} gathering</span></span>`
  : `<span class="num">${duration(plan?.hours)}</span>`);

// Whether what you're doing in the game right now is working towards a plan: its training method,
// one of the gathering steps it needs, or at least the same skill.
function doing(activity, skill, plan) {
  if (!activity?.skill) return null;
  const key = activity.method?.key;
  if (key && plan?.steps.some((st) => st.method.key === key)) return { on: true, text: "You're doing this" };
  if (key && plan?.gather.some((g) => [...g.needs, g].some((n) => n.method?.key === key))) return { on: true, text: "You're gathering for this" };
  if (activity.skill !== skill) return null;
  const first = plan?.steps[0]?.method;
  return { on: false, text: "You're training this", hint: first && first.key !== key ? `${first.name} gets there sooner` : '' };
}

// An Agility path picked in the game but not running yet: the course keeps the path it started on.
const pathNote = (activity) => `<p class="notice warn">The game is still running <strong>${esc(activity.method.name)}</strong>. You picked ${esc(activity.picked.name)}, but a course keeps the path it started on: press Stop Course, then Start Course, to switch.</p>`;

const doingPill = (d) => (d ? ` <span class="pill ${d.on ? 'good' : 'accent'}">${esc(d.text)}</span>${d.hint ? `<span class="sub small accent-text">${esc(d.hint)}</span>` : ''}` : '');

export function next(ctx) {
  const { gd } = ctx;
  // Planning every skill takes a moment, so it's worked out once per autosave, not on every click.
  const plan = memo('next:plan', saveKey(ctx), () => trainNext(gd, ctx.levels, ctx.xp, { bank: ctx.stock, current: currentMethodKey(ctx) }));
  const money = memo('next:money', saveKey(ctx), () => bestMoney(gd, ctx.levels, { bank: ctx.stock, limit: 5 }));
  const activity = ctx.save && ctx.state.levelSource === 'save' ? currentActivity(gd, ctx.save.header, ctx.levels) : null;
  const quick = plan.quickWins.slice(0, 8).map((row) => {
    const d = doing(activity, row.skill, row.next.plan);
    return `<li${d ? ` class="doing${d.on ? ' on' : ''}"` : ''}>
      <span>${badge(row.skill, skillName(ctx, row.skill))} <a href="#/skills/${row.skill}">${esc(skillName(ctx, row.skill))}</a> ${row.level} → <strong>${row.next.level}</strong>${doingPill(d)}
      <span class="sub small">Unlocks ${row.next.methods.map((m) => esc(m.name)).join(', ')}</span>${planNote(ctx, row.next.plan)}</span>
      ${planTime(row.next.plan)}</li>`;
  });
  const blocked = plan.blocked.map((row) => esc(skillName(ctx, row.skill)));
  const upgrades = plan.moneyUpgrades.slice(0, 6).map((row) => {
    const d = doing(activity, row.skill, row.money.plan);
    return `<li${d ? ` class="doing${d.on ? ' on' : ''}"` : ''}>
      <span>${badge(row.skill, skillName(ctx, row.skill))} <a href="#/skills/${row.skill}">${esc(skillName(ctx, row.skill))}</a> to <strong>${row.money.level}</strong>${doingPill(d)}
      <span class="sub muted small">${esc(row.money.rates.method.name)} · ${gp(row.money.rates.profitPerHour)} GP/h (${gp(row.money.gain, { signed: true })})</span>${planNote(ctx, row.money.plan)}</span>
      ${planTime(row.money.plan)}</li>`;
  });
  const best = money.selfSufficient.map((x) => {
    const on = activity?.method?.key === x.rates.method.key;
    return `<li${on ? ' class="doing on"' : ''}><span>${methodLink(x.rates.method)} <span class="muted small">${esc(skillName(ctx, x.rates.method.skill))}</span>${on ? ' <span class="pill good">You\'re doing this</span>' : ''}</span><span class="num">${signed(x.rates.profitPerHour)} GP/h</span></li>`;
  });
  const basis = ctx.bank
    ? 'The quickest way to unlock new things, then Mastery ranks and money worth going for. Worked out from your levels and your bank.'
    : 'The quickest way to unlock new things, then money worth going for. Worked out from your levels; no bank loaded, so it assumes you have the materials.';
  const now = activity?.skill
    ? `<p class="notice">You're on <strong>${esc(activity.method?.name ?? activity.label)}</strong> (${esc(skillName(ctx, activity.skill))} ${ctx.levels[activity.skill]}). Anything it counts towards is highlighted.</p>${activity.picked ? pathNote(activity) : ''}`
    : '';
  return `${pageHead('What should I do next?', basis)}${now}
    ${routeCard(ctx)}
    <div class="grid two" style="margin-top:12px">
      ${masteryTeaser(ctx, activity)}
      ${card('Money upgrades', upgrades.length ? `<p class="small muted">The next level in each skill where its best no-materials money maker beats today's best (${gp(plan.baselineProfit)} GP/h), by unlocking something new or because your success chance improves.</p><ul class="list-plain">${upgrades.join('')}</ul>` : '<p class="muted">Nothing coming up beats your best money method yet.</p>')}
    </div>
    <div class="grid two" style="margin-top:12px">
      ${card('Best money right now', `<ul class="list-plain">${best.join('')}</ul><p class="small" style="margin-top:8px"><a href="#/money">All money methods</a></p>`)}
      ${ctx.bank ? bankTeaser(ctx) : card('Turn your bank into money', '<p class="muted small">Load a save to see which crafts pay off with what you already own.</p>')}
    </div>
    <section class="card" style="margin-top:12px"><details class="row-detail"><summary><strong>Every skill's next unlock, one at a time</strong> <span class="muted small">· ${exact(plan.quickWins.length)} skills</span></summary>
      <p class="small muted" style="margin-top:8px">Each skill on its own, quickest first, as if it had your whole bank to itself. The route above puts them in order and shares your bank between them.</p>${quick.length ? `<ul class="list-plain">${quick.join('')}</ul>` : '<p class="muted">Everything is unlocked.</p>'}${blocked.length ? `<p class="small muted" style="margin-top:8px">Not listed: ${blocked.join(', ')}. They need materials you don't have and can't gather yet.</p>` : ''}</details></section>`;
}

// The Mastery Guild ranks closest to you that make you faster, with what they're worth.
function masteryTeaser(ctx, activity) {
  const plans = masteryPlanFor(ctx);
  const more = '<p class="small" style="margin-top:8px"><a href="#/mastery">Every skill\'s next rank</a></p>';
  if (!plans) return card('Mastery ranks worth getting', '<p class="muted small">Load a save to see which Mastery Guild ranks are closest and what they\'d do for you.</p>');
  const rows = ranksWorthGetting(plans).slice(0, 4).map((p) => rankRow(ctx, p, { activity }));
  return card('Mastery ranks worth getting', `${rows.length ? `<ul class="list-plain">${rows.join('')}</ul>` : '<p class="muted small">No rank within two days does something the companion can put a number on.</p>'}${more}`);
}

function bankTeaser(ctx) {
  const b = memo('next:bank', saveKey(ctx), () => bankInsights(ctx.gd, ctx.bank, ctx.levels));
  const rows = b.processing.slice(0, 5).map((p) => `<li><span>Make ${exact(p.crafts)} × ${methodLink(p.method)} <span class="muted small">${duration(p.hours)}</span></span><span class="num">${signed(p.totalGain)}</span></li>`);
  return card('Turn your bank into money', rows.length ? `<ul class="list-plain">${rows.join('')}</ul><p class="small muted" style="margin-top:8px">Lines that share materials are alternatives. <a href="#/bank">Bank details</a></p>` : '<p class="muted small">Nothing in your bank is worth more after crafting at your levels.</p>');
}
