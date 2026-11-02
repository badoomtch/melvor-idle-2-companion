// Slayer: what each master pays with your gear, and your current tasks.
import { STYLES } from '/engine/combat.js';
import { bestFightsByEnemy, slayerOverview } from '/engine/slayer.js';
import { badge, duration, esc, exact, iconImg, num } from '/ui/format.js';
import { combatRecommendation, STYLE_SKILL, styleOptions } from './combat.js';
import { pageHead, requirementText, stat, table } from './shared.js';

// ---------- Slayer ----------

export function slayer(ctx) {
  const { gd, state } = ctx;
  const head = pageHead('Slayer', 'What each slayer master\'s tasks are worth with the best gear you own, and whether your current tasks are worth finishing.');
  if (!gd.combat?.slayerMasters?.length) return `${head}<p class="notice warn">This data build has no slayer masters. Run <code>npm run build-data</code> again.</p>`;
  if (!ctx.save?.combat || !ctx.bank) return `${head}<div class="card empty"><h2>Load a save to see slayer advice</h2><p>It needs your gear and bank to work out kill speeds.</p></div>`;
  const best = bestFightsByEnemy(STYLES.map((style) => combatRecommendation(ctx, style)));
  const coins = ctx.save.header.slayerCoins ?? 0;
  const masters = slayerOverview(gd, { levels: ctx.levels, bestFights: best, tasks: ctx.save.slayer ?? {}, coins });
  const byCoins = state.ui.slayerSort === 'coins';
  const rate = (m) => (byCoins ? m.average.coinsPerHour : m.average.slayerXpPerHour);
  const coinName = esc(gd.currencyName('SlayerCoins'));

  const advice = {
    keep: '<span class="pill live">Keep</span>',
    reroll: '<span class="pill warn">Slow, worth a reroll</span>',
    'reroll-risky': '<span class="pill bad">Can hit you hard, reroll</span>',
    risky: '<span class="pill bad">Can hit you hard</span>',
    unreachable: '<span class="pill">Area not open to you yet</span>',
  };
  const tasks = masters.filter((m) => m.task).map((m) => {
    const t = m.task;
    const f = t.fight;
    // Each style with the best gear you own for this enemy; the most kills an hour finishes the task first.
    const styles = styleOptions(ctx, { target: t.enemy }).filter((x) => !x.why).sort((a, b) => b.r.killsPerHour - a.r.killsPerHour);
    const top = styles[0];
    const hoursLeft = top ? t.left / top.r.killsPerHour : t.hoursLeft;
    const others = styles.slice(1).map((x) => `${x.style} ${num(x.r.killsPerHour)}`).join(', ');
    const fightWith = top
      ? `${badge(STYLE_SKILL[top.style], top.style)} ${top.style}<span class="sub">${num(top.r.killsPerHour)} kills/h${others ? ` · ${esc(others)}` : ''}</span><button class="link small" data-action="combatTarget" data-style="${top.style}" data-enemy="${esc(t.enemy.id)}" data-go="#/combat">See the gear</button>`
      : f ? `${badge(STYLE_SKILL[f.style], f.style)} ${f.style}` : '–';
    return `<tr><td>${iconImg(m.master.icon, 'icon sm')}${esc(m.master.name)}</td>
      <td>${iconImg(t.enemy.icon, 'icon sm')}${esc(t.enemy.name)}<span class="sub">${exact(t.progress)} / ${exact(t.length)} done${f ? ` · ${esc(f.area.name)}` : ''}</span></td>
      <td>${fightWith}</td>
      <td class="num">${Number.isFinite(hoursLeft) ? duration(hoursLeft) : '–'}</td>
      <td class="num">${num(t.left * (t.xpPerKill ?? 0))}</td>
      <td class="num">${num(t.left * (t.coinsPerKill ?? 0))}</td>
      <td>${advice[t.advice]}${t.advice.startsWith('reroll') ? ` <span class="muted small">${exact(m.master.rerollCost.qty)} ${coinName}</span>` : ''}</td></tr>`;
  });

  const rows = [...masters].sort((x, y) => Number(y.unlocked) - Number(x.unlocked) || rate(y) - rate(x)).map((m) => {
    const areas = m.master.areas.map((a) => gd.areaById.get(a)?.name ?? a).join(', ');
    const risky = m.enemies.filter((e) => e.risky).length;
    const unreachable = m.enemies.filter((e) => !e.reachable).length;
    const worst = m.enemies.filter((e) => e.reachable && !e.risky).sort((x, y) => x.slayerXpPerHour - y.slayerXpPerHour)[0];
    const notes = [];
    if (!m.unlocked) notes.push(`<span class="pill">Needs ${requirementText(ctx, m.missing)}</span>`);
    if (risky) notes.push(`<span class="pill warn">${risky} of ${m.enemies.length} too dangerous with your gear</span>`);
    if (m.unlocked && unreachable) notes.push(`<span class="pill">${unreachable} in areas not open to you yet</span>`);
    if (m.unlocked && worst && m.doable > 1) notes.push(`<span class="small muted">Slowest: ${esc(worst.enemy.name)}</span>`);
    return `<tr class="${m.unlocked ? '' : 'locked'}"><td>${iconImg(m.master.icon, 'icon sm')}${esc(m.master.name)}<span class="sub">${esc(areas)}</span></td>
      <td class="num">${m.doable ? num(m.average.slayerXpPerHour) : '–'}</td>
      <td class="num">${m.doable ? num(m.average.coinsPerHour) : '–'}</td>
      <td class="num">${m.doable ? num(m.average.combatXpPerHour) : '–'}</td>
      <td class="num">${m.length.min}–${m.length.max}</td>
      <td class="small">${notes.join(' ')}</td></tr>`;
  });
  const sort = `<div class="segmented" role="group" aria-label="Rank masters by">${[['xp', 'Slayer XP'], ['coins', coinName]].map(([v, l]) => `<button data-action="slayerSort" data-value="${v}" aria-pressed="${(state.ui.slayerSort ?? 'xp') === v}">${l}</button>`).join('')}</div>`;
  return `${head}
    <div class="grid stats">${stat('Slayer level', exact(ctx.levels.Slayer ?? 1))}${stat(coinName, exact(coins))}</div>
    <h2>Your tasks</h2>${table(['Master', 'Task', 'Fight with', '#Time left', '#Slayer XP left', `#${coinName} left`, ''], tasks, 'No tasks right now. Pick a master below.')}
    <h2>Masters</h2><div class="form-row">${sort}</div>
    ${table(['Master', '#Slayer XP/h', `#${coinName}/h`, '#Combat XP/h', '#Task kills', ''], rows)}
    <p class="small muted" style="margin-top:10px">For each task, "Fight with" is the style that kills fastest with the best gear you own for that enemy, with the other styles' kills an hour beside it. A master's rate averages every enemy it can assign, fought with your best gear for that enemy (any style). Enemies that can hit you for most of your health count as rerolls. Task kills range from the base length up to base + 3 per Slayer level.</p>`;
}
