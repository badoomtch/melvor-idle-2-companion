// Skills: every training method for one skill.
import { planTraining, rankSkill } from '/engine/advisor.js';
import { farmingPlots, plotRanges } from '/engine/farming-plots.js';
import { grainMillModel } from '/engine/grain-mill.js';
import { masteryStatus } from '/engine/mastery.js';
import { ranchModel } from '/engine/ranch.js';
import { STEP_VERBS } from '/engine/route-progress.js';
import { badge, duration, esc, exact, iconImg, num, pct } from '/ui/format.js';
import { handsOnTasks, masteryPlanFor, rankBonusText, taskLine } from './mastery-ui.js';
import { card, gatherStep, itemLink, memo, methodIcon, methodLink, methodRows, pageHead, saveKey, skillName, stat, table } from './shared.js';

const HOUR_MS = 3_600_000;
const hoursUntil = (at) => Math.max(0, at - Date.now()) / HOUR_MS;
const humanize = (s) => String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();

// Farming plots from the save: what each plot grows and when it's ready, counted from the save's own
// time so it stays right between autosaves.
function farmingCard(ctx) {
  if (!ctx.save?.farming || ctx.state.levelSource !== 'save') return '';
  const f = farmingPlots(ctx.gd, ctx.save);
  if (!f) return '';
  // Plots with the same crop, care and finish time (within a minute) share a line.
  const lines = [];
  for (const p of f.plots.filter((x) => x.state !== 'locked' && x.state !== 'empty')) {
    const key = [p.recipe, p.status, p.watered, p.compost, p.auto?.harvest, p.regrowsRemaining, p.paused].join('|');
    const same = lines.find((l) => l.key === key && Math.abs((l.plots[0].readyAt ?? 0) - (p.readyAt ?? 0)) < 60_000);
    if (same) same.plots.push(p);
    else lines.push({ key, plots: [p] });
  }
  const rank = (p) => (p.status === 'ready' ? 0 : p.status === 'harvesting' ? 1 : 2);
  lines.sort((a, b) => rank(a.plots[0]) - rank(b.plots[0]) || (a.plots[0].readyAt ?? Infinity) - (b.plots[0].readyAt ?? Infinity));
  const rows = lines.map(({ plots }) => {
    const p = plots[0];
    const crop = p.method?.name ?? humanize(p.recipe);
    const notes = [plotRanges(plots), p.watered ? 'watered' : '', p.compost ? esc(ctx.gd.itemName(`MelvorBase:${p.compost}`)) : '', p.regrowsRemaining > 0 ? `${p.regrowsRemaining} regrow${p.regrowsRemaining === 1 ? '' : 's'} left` : '', p.auto?.harvest ? 'harvests itself' : ''].filter(Boolean);
    const when = p.status === 'ready' ? '<span class="pill good">Ready to harvest</span>'
      : p.status === 'harvesting' ? '<span class="muted">Harvesting itself</span>'
        : p.paused ? `Paused, ${duration(p.msLeft / HOUR_MS)} left`
          : p.status === 'bonus' ? `Bonus for ${duration(p.msLeft / HOUR_MS)}`
            : p.msLeft != null ? duration(p.msLeft / HOUR_MS) : '–';
    return `<li><span class="with-icon">${p.method ? methodIcon(ctx.gd, p.method) : ''}<span>${esc(crop)}${plots.length > 1 ? ` <span class="muted">× ${plots.length}</span>` : ''}<span class="small muted sub">${notes.join(' · ')}</span></span></span><span class="num">${when}</span></li>`;
  });
  const empty = f.plots.filter((p) => p.state === 'empty');
  const locked = f.plots.filter((p) => p.state === 'locked');
  const short = [empty.length ? `Empty: ${esc(plotRanges(empty))}.` : '', locked.length ? `Locked (${exact(locked.length)}): ${esc(plotRanges(locked))}.` : ''].filter(Boolean).join(' ');
  return card('Farming plots', `
    ${rows.length ? `<ul class="list-plain">${rows.join('')}</ul>` : '<p class="muted">Nothing planted.</p>'}
    ${short ? `<p class="small muted" style="margin-top:8px">${short}</p>` : ''}
    <p class="small muted">Times count from the last autosave. Plots keep growing while the game is closed.</p>`, ' style="margin-bottom:12px"');
}

// The Grain Mill in the save: what it's making, how much an hour, how long its storage lasts and how
// full it is, and how much of the ranch's food it covers.
function grainMillCard(ctx) {
  if (!ctx.save?.grainMill || ctx.state.levelSource !== 'save') return '';
  const { gd } = ctx;
  const m = grainMillModel(gd, ctx.save, { ranch: ctx.save.ranching ? ranchModel(gd, ctx.save) : null });
  if (!m) return '';
  const style = ' style="margin-bottom:12px"';
  if (!m.owned) return card(esc(m.name), '<p class="muted">Buy the Grain Mill in the shop to turn Wheat, Sugarcane, Corn and Flax into flour, sugar and grain while you do other things.</p>', style);
  const r = m.rates;
  const amount = (list) => list.map((i) => `${exact(i.qty)} ${esc(gd.itemName(i.item))}`).join(' and ');
  const short = r?.ingredients.filter((i) => (ctx.save.grainMill.storage[i.item] ?? 0) < i.qty) ?? [];
  const inBank = short.filter((i) => (ctx.save.bank?.items?.[i.item] ?? 0) > 0);
  const status = m.running
    ? `<p>Making <strong>${esc(r.recipe.name)}</strong>: ${amount([r.product])} every ${duration(r.intervalMs / HOUR_MS)} from ${amount(r.ingredients)}. Next batch in ${duration(hoursUntil(m.nextAt))}.</p>`
    : m.reason === 'none' ? '<p class="notice warn">No recipe picked, so it isn\'t making anything. Pick one in the game.</p>'
      : m.reason === 'empty' ? `<p class="notice warn">Stopped: ${esc(r.recipe.name)} needs ${amount(r.ingredients)} a batch and the mill's storage has ${amount(short.map((i) => ({ item: i.item, qty: ctx.save.grainMill.storage[i.item] ?? 0 })))}. ${inBank.length === short.length ? `Move ${inBank.map((i) => esc(gd.itemName(i.item))).join(' and ')} from your bank into the mill and switch it on.` : `Grow more ${short.map((i) => esc(gd.itemName(i.item))).join(' and ')} first.`}</p>`
        : `<p class="notice warn">Switched off, with enough in storage for ${exact(m.batches)} batch${m.batches === 1 ? '' : 'es'} of ${esc(r.recipe.name)}. Switch it on in the game.</p>`;
  const lasts = m.running ? duration(m.hoursLeft) : 'Not running';
  const stats = r ? `<div class="grid stats">${stat('Makes per hour', `${num(r.perHour)} <span class="muted small">${esc(gd.itemName(r.product.item))}</span>`)}${stat('Uses per hour', r.inputsPerHour.map((i) => `${num(i.perHour)} <span class="muted small">${esc(gd.itemName(i.item))}</span>`).join('<br>'))}${stat('Storage lasts', lasts)}</div>` : '';
  const storage = m.storage.map((s) => `<li><span style="flex:1;margin-right:16px">${itemLink(ctx, s.item)}<span class="small muted sub">${s.used ? 'used by this recipe · ' : ''}${s.bank > 0 ? `${exact(s.bank)} in the bank` : 'none in the bank'}</span><div class="bar${s.share >= 0.95 ? ' warn' : ''}" role="progressbar" aria-label="${esc(gd.itemName(s.item))} storage" aria-valuenow="${Math.round(s.share * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${(s.share * 100).toFixed(1)}%"></span></div></span><span class="num">${exact(s.qty)} <span class="muted small">of ${exact(s.capacity)}</span></span></li>`);
  const topUp = r && m.topUp.batches > m.batches ? `<p class="small muted">Topped up from your bank, its storage would make ${exact(m.topUp.batches)} batch${m.topUp.batches === 1 ? '' : 'es'}, about ${duration(m.topUp.hours)} of milling.</p>` : '';
  const feeds = m.feeds.map((f) => `<p class="small">Your ranch eats ${num(f.eats)} ${esc(gd.itemName(f.item))} an hour. ${m.running ? 'The mill makes' : 'Running, the mill would make'} ${num(f.makes)}, ${f.covers >= 1 ? `${num(f.covers)} times what the herd needs` : `${pct(f.covers)} of what the herd needs`}.</p>`);
  return card(esc(m.name), `${status}${stats}
    <h4 style="margin-top:12px">Storage</h4>
    <ul class="list-plain">${storage.join('')}</ul>
    ${topUp}${feeds.join('')}
    <p class="small muted">The mill only takes crops from its own storage, not the bank. Products go to the bank. Times count from the last autosave.</p>`, style);
}

// The ranch in the save: each enclosure's animals, what the whole herd makes in an hour once the game
// has rounded each total down, and what needs looking after.
function ranchCard(ctx) {
  if (!ctx.save?.ranching || ctx.state.levelSource !== 'save') return '';
  const { gd } = ctx;
  const r = ranchModel(gd, ctx.save);
  if (!r) return '';
  if (!r.enclosures.length) return card('Your ranch', '<p class="muted">No enclosures built yet.</p>', ' style="margin-bottom:12px"');
  const pill = { bad: 'bad', warn: 'warn', info: 'accent' };
  const attention = r.attention.map((a) => `<li><span>${esc(a.text)}${a.kind === 'old' ? ` <span class="muted">First in ${duration(hoursUntil(a.at))}.</span>` : ''}</span><span class="num"><span class="pill ${pill[a.severity]}">${esc({ hungry: 'Hungry', sick: 'Sick', old: 'Old age', repair: 'Repair', pets: 'Pets', empty: 'Empty' }[a.kind])}</span></span></li>`);
  const lost = r.hourly.products.reduce((s, p) => s + p.lost, 0);
  const two = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const products = r.hourly.products.map((p) => `<tr><td>${itemLink(ctx, p.item)}</td><td class="num">${two(p.perHour)}</td><td class="num muted">${two(p.unrounded)}</td></tr>`);
  products.push(`<tr><td>${esc(skillName(ctx, 'Ranching'))} XP <span class="small muted">(not rounded)</span></td><td class="num">${num(r.hourly.xp)}</td><td class="num muted">${num(r.hourly.xp)}</td></tr>`);
  // Food the Grain Mill's recipe makes (grain), and how much an hour.
  const mill = ctx.save.grainMill ? grainMillModel(gd, ctx.save, { ranch: r }) : null;
  const milled = (item) => {
    const f = mill?.feeds.find((x) => x.item === item);
    return f ? `, the Grain Mill ${mill.running ? 'makes' : 'would make'} ${num(f.makes)}/h` : '';
  };
  const food = r.hourly.food.map((x) => `<li><span>${itemLink(ctx, x.item)}</span><span class="num">${num(x.perHour)}/h <span class="small muted sub">${x.have > 0 ? `${exact(x.have)} in the bank, ${duration(x.hoursLeft)}` : 'none in the bank'}${milled(x.item)}</span></span></li>`);
  // Whether each species can have babies here, and how often (the game's rules are in engine/ranch.js).
  const speciesName = (s) => esc(gd.methodByKey.get(`Ranching/${s}`)?.name ?? humanize(s));
  const babyText = (e, b) => {
    const name = esc(b.name);
    const first = b.blockedBy ? speciesName(b.blockedBy) : '';
    const alsoFirst = b.blockedBy && b.reason !== 'skipped' ? ` It also needs 2 ${first} here: the game checks ${first} first and stops there.` : '';
    if (!b.reason) return `${name}: a baby about every ${duration(b.everyHours)} (${pct(1 - Math.pow(1 - b.perHour, 24), 2)} chance a day) while there's room. It makes half as much until it grows up, ${duration(b.child?.hours)} later.`;
    if (b.reason === 'small') return `${name}: no babies. ${esc(e.name)} holds 2, and a baby needs 2 of a kind plus room for one more, so it needs a bigger enclosure.`;
    if (b.reason === 'few') return `${name}: no babies until there are 2 of them and room for one more.${alsoFirst}`;
    if (b.reason === 'full') return `${name}: no babies, they fill the enclosure.`;
    if (b.reason === 'skipped') return `${name}: no babies while there are fewer than 2 ${first} here. The game checks ${first} first and stops there.`;
    if (b.reason === 'unhappy') return `${name}: no babies until one is at least 75% happy (they average ${pct(b.happiness)}).`;
    return `${name}: no babies, the enclosure is full (${exact(e.animals.length)} of ${exact(e.limit)}).`;
  };
  // Treats raise satisfaction; the ones missing from the bank are the ones worth getting.
  const treatName = (x) => `${esc(gd.itemName(x.item))}${x.perDay !== 1 ? ` × ${num(x.perDay)}` : ''}`;
  const fed = r.hourly.treats.filter((x) => x.have > 0).map(treatName);
  const missing = r.hourly.treats.filter((x) => !(x.have > 0)).map(treatName);
  const treats = [fed.length ? `Treats eaten once a day: ${fed.join(', ')}.` : '', missing.length ? `Not in the bank, so not given: ${missing.join(', ')}.` : ''].filter(Boolean);
  // Alike animals (same species, variant, age group and state) share a line.
  const enclosure = (e) => {
    const groups = [];
    for (const a of e.animals) {
      const flags = [a.sick ? 'sick' : '', a.hunger < 1 ? 'hungry' : '', a.wantsPets ? 'wants petting' : ''].filter(Boolean);
      const key = [a.species, a.variantName, a.child, Math.round(a.happiness * 100), flags.join()].join('|');
      const g = groups.find((x) => x.key === key);
      if (g) g.animals.push(a);
      else groups.push({ key, flags, animals: [a] });
    }
    const rows = groups.map(({ animals, flags }) => {
      const a = animals[0];
      const death = Math.min(...animals.map((x) => x.deathAt));
      const age = a.child ? `child, grows up in ${duration(hoursUntil(Math.min(...animals.map((x) => x.adultAt))))}` : `${animals.length > 1 ? 'first dies' : 'dies'} of age in ${duration(hoursUntil(death))}`;
      const variant = a.child || a.variantName === 'Adult' ? '' : ` <span class="muted">${esc(a.variantName)}</span>`;
      return `<li><span class="with-icon">${a.method ? methodIcon(gd, a.method) : ''}<span>${esc(a.name)}${variant}${animals.length > 1 ? ` <span class="muted">× ${animals.length}</span>` : ''}<span class="small muted sub">${[age, ...flags].join(' · ')}</span></span></span><span class="num${a.happiness < 0.75 ? ' warn-text' : ''}">${Math.round(a.happiness * 100)}% happy</span></li>`;
    });
    const extra = [e.autoBuy.length ? `auto-buy: ${e.autoBuy.map((s) => esc(gd.methodByKey.get(`Ranching/${s}`)?.name ?? s)).join(', ')}` : '', e.upgrades.length ? `upgrades: ${e.upgrades.map((u) => esc(humanize(u))).join(', ')}` : ''].filter(Boolean);
    return `<h4 style="margin-top:12px">${esc(e.landName)}: ${esc(e.name)}</h4>
      <p class="small muted">${e.limit ? `${exact(e.animals.length)} of ${exact(e.limit)} animals` : `${exact(e.animals.length)} animal${e.animals.length === 1 ? '' : 's'}`} · upkeep ${Math.round(e.maintenance * 100)}%${extra.length ? ` · ${extra.join(' · ')}` : ''}</p>
      ${rows.length ? `<ul class="list-plain">${rows.join('')}</ul>` : ''}
      ${e.births?.length ? `<p class="small" style="margin-top:6px">${e.births.map((b) => babyText(e, b)).join('<br>')}</p>` : ''}`;
  };
  const next = r.nextProductsAt != null ? ` Next products in ${duration(hoursUntil(r.nextProductsAt))}.` : '';
  return card('Your ranch', `
    <p>${exact(r.animals)} animal${r.animals === 1 ? '' : 's'} in ${exact(r.enclosures.length)} enclosure${r.enclosures.length === 1 ? '' : 's'}.${next}</p>
    ${attention.length ? `<ul class="list-plain">${attention.join('')}</ul>` : ''}
    <h4 style="margin-top:12px">Each hour</h4>
    ${table(['Item', '#Per hour', '#Before rounding'], products)}
    <p class="small muted" style="margin-top:6px">The game adds each product up over all your animals and rounds it down once an hour${lost >= 0.05 ? `, so this herd loses about ${num(lost)} items an hour to rounding` : ''}. Happiness scales what each animal makes; children make half.${ctx.gd.playerBonuses ? ' Includes your bonuses.' : ''}</p>
    ${food.length ? `<h4 style="margin-top:12px">Eats</h4><ul class="list-plain">${food.join('')}</ul>` : ''}
    ${treats.length ? `<p class="small muted">${treats.join(' ')}</p>` : ''}
    ${r.enclosures.map(enclosure).join('')}
    ${r.births.length ? '<p class="small muted" style="margin-top:8px">Babies: once an hour each enclosure has a 0.01% chance for every animal of a kind at 75% happiness or more, times their average happiness. A baby is free and grows into a variant like a bought animal.</p>' : ''}
    ${r.variantGuess ? '<p class="small muted" style="margin-top:8px">Special variants (like Chonky) count as plain adults here: the companion\'s data doesn\'t list their bonuses yet.</p>' : ''}`, ' style="margin-bottom:12px"');
}

// The skill's Mastery Guild rank from the save: points, the next rank and what it adds.
function masteryCard(ctx, skill) {
  if (!ctx.save?.mastery || ctx.state.levelSource !== 'save') return '';
  const m = masteryStatus(ctx.gd, ctx.save, ctx.levels)[skill];
  if (!m) return '';
  const effects = rankBonusText;
  const nextAt = m.next ? m.points + m.pointsToNext : m.total;
  const share = nextAt > 0 ? Math.min(1, m.points / nextAt) : 1;
  const have = m.bonuses.filter((b) => b.effects.length || b.mods?.length);
  // The cheapest tasks to the next rank, at your current rates.
  const plan = masteryPlanFor(ctx)?.find((p) => p.skill === skill);
  const route = !m.next ? ''
    : plan?.plan
      ? `<h4 style="margin-top:10px">Quickest way to ${esc(m.next.name)}: about ${duration(plan.plan.hours)}</h4><ul class="list-plain">${plan.plan.tasks.map((t) => taskLine(ctx, t)).join('')}</ul><p class="small muted">${exact(plan.plan.tasks.length)} tasks worth ${exact(plan.plan.points)} points, cheapest first. Tasks that count the same thing share progress, so the bigger one only adds its extra.</p>`
      : `<p class="small muted" style="margin-top:8px">The companion can't time enough of this skill's tasks to plan the next rank${plan ? ` (${exact(plan.open.filter((t) => t.hours != null).length)} of ${exact(plan.open.length)} open tasks timed)` : ''}.</p>`;
  return card(`Mastery Guild: ${esc(m.rank?.name ?? 'no rank yet')}`, `
    <div class="bar" role="progressbar" aria-label="Points towards the next rank" aria-valuenow="${Math.round(share * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${(share * 100).toFixed(1)}%"></span></div>
    <p class="small">${exact(m.points)} of ${exact(m.total)} points from ${exact(m.done)} of ${exact(m.tasks)} tasks.${m.next ? ` <strong>${esc(m.next.name)}</strong> at ${exact(nextAt)} points (${exact(m.pointsToNext)} to go)${m.nextBonus ? `: ${esc(effects(m.nextBonus))}` : ''}.` : ' Top rank.'}</p>
    ${have.length ? `<p class="small muted">Counted in the rates below: ${have.map((b) => `${esc(b.rankName)} (${esc(effects(b))})`).join('; ')}.</p>` : ''}${route}${m.next ? handsOnTasks(ctx, plan) : ''}`, ' style="margin-bottom:12px"');
}

// ---------- Skills ----------

// The quickest way from where you are to the next level that unlocks something (or the level you're
// planning for, when that's further): one method per stretch between unlocks, as you'd play it, counting
// only on what's in your bank and getting whatever you're short of first (planTraining).
function pathCard(ctx, skill, planFor) {
  const { gd } = ctx;
  const now = gd.levelOf(ctx.levels, skill);
  if (now >= gd.levelCap) return '';
  const unlock = Math.min(...(gd.methodsBySkill[skill] ?? []).map((m) => m.level).filter((l) => l > now), gd.levelCap);
  const target = planFor > now ? planFor : unlock;
  const xpNow = ctx.xp[skill] ?? gd.xp.xpForLevel(now);
  const plan = memo('skills:path', `${saveKey(ctx)}|${skill}|${target}`, () => planTraining(gd, skill, ctx.levels, xpNow, target, { bank: ctx.stock }));
  const title = `Quickest way to ${esc(skillName(ctx, skill))} ${target}`;
  if (plan.blocked) return card(title, '<p class="muted">Nothing you can do yet gets there: a method on the way needs something you can&#39;t get.</p>');
  const rows = plan.steps.flatMap((st) => [
    ...st.gather.map((g) => `<li><span>First ${[...g.needs, g].map((n) => gatherStep(ctx, n)).join(', then ')}</span><span class="num">${duration(g.hours ?? 0)}</span></li>`),
    `<li><span>${STEP_VERBS[st.method.kind] ?? 'Do'} ${methodLink(st.method)} × ${exact(Math.ceil(st.actions))} <span class="muted small">${st.toLevel > st.fromLevel ? `level ${st.fromLevel} → ${st.toLevel}` : `at level ${st.fromLevel}, ${st.limitedBy ? `until you run out of ${itemLink(ctx, st.limitedBy)}` : 'as far as your materials go'}`}</span></span><span class="num">${duration(st.hours)}</span></li>`,
  ]);
  const why = target === unlock ? `the next level that unlocks something new${planFor > now ? '' : '. Set "Level to plan for" below to plan further'}` : "the level you're planning for";
  return card(title, `<p class="small muted">About <strong>${duration(plan.hours)}</strong>${plan.gatherHours >= 1 / 60 ? ` (${duration(plan.trainHours)} training, ${duration(plan.gatherHours)} getting materials)` : ''} to ${why}. Uses what's in your bank, and changes method only when it's worth it.</p>
    <ol class="list-plain">${rows.join('')}</ol>`, ' style="margin-bottom:12px"');
}

export function skills(ctx, [skillArg]) {
  const { gd, state } = ctx;
  const skill = gd.trainableSkills.includes(skillArg) ? skillArg : state.ui.lastSkill && gd.trainableSkills.includes(state.ui.lastSkill) ? state.ui.lastSkill : gd.trainableSkills[0];
  state.ui.lastSkill = skill;
  const override = state.ui.skillOverride[skill];
  const level = override ?? ctx.levels[skill] ?? 1;
  const levels = { ...ctx.levels, [skill]: level };
  const ranked = rankSkill(gd, skill, levels, { by: state.ui.sort === 'profit' ? 'profit' : 'xp' });
  const sort = state.ui.sort;
  const all = [...ranked.available, ...ranked.all.filter((x) => !x.ok).sort((a, b) => a.method.level - b.method.level)];
  if (sort === 'level') all.sort((a, b) => a.method.level - b.method.level || a.method.name.localeCompare(b.method.name));
  const chips = gd.trainableSkills
    .map((s) => `<a class="chip" href="#/skills/${s}"${s === skill ? ' aria-current="page"' : ''}>${badge(s, skillName(ctx, s))}${esc(skillName(ctx, s))} <span class="muted">${ctx.levels[s] ?? 1}</span></a>`)
    .join('');
  const controls = `<div class="form-row">
      <label>Level to plan for <input id="skill-level" type="number" min="1" max="${gd.levelCap}" value="${level}" data-bind="skillLevel" data-skill="${skill}"></label>
      ${override != null ? `<button data-action="resetSkillLevel" data-skill="${skill}">Back to my level (${ctx.levels[skill] ?? 1})</button>` : ''}
      <div class="segmented" role="group" aria-label="Sort by">
        ${[['xp', 'XP/h'], ['profit', 'GP/h'], ['level', 'Level']].map(([v, l]) => `<button data-action="sort" data-value="${v}" aria-pressed="${sort === v}">${l}</button>`).join('')}
      </div>
    </div>`;
  return `${pageHead(`${badge(skill, skillName(ctx, skill))} ${esc(skillName(ctx, skill))}`, `${ranked.available.length} of ${ranked.all.length} methods unlocked at level ${level}. Click a method for the full breakdown.`)}
    <div class="chips">${chips}</div>
    ${pathCard(ctx, skill, override)}
    ${masteryCard(ctx, skill)}
    ${skill === 'Farming' ? `${farmingCard(ctx)}${grainMillCard(ctx)}` : skill === 'Ranching' ? ranchCard(ctx) : ''}
    ${controls}
    ${table(['Method', '#Lvl', '#XP / h', '#GP / h', 'Notes'], methodRows(ctx, all, { columns: [], markBest: sort !== 'level' }))}
    <p class="small muted" style="margin-top:10px">GP/h is profit: what you gain minus what you use up (materials and food), at sell prices. ${ctx.gd.playerBonuses ? 'Includes your shop upgrades, toolbelt items, pets and Mastery Guild rank.' : 'Base rates (bonuses switched off in Settings).'}</p>`;
}
