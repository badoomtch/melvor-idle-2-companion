// Quests: where you are in each quest, what the current step needs, and what you can start next.
import { obtain, producerIndex } from '/engine/advisor.js';
import { questStatus } from '/engine/quests.js';
import { duration, esc, exact, gp } from '/ui/format.js';
import { card, itemLink, levelsKey, memo, methodLink, noSaveCard, pageHead, skillName } from './shared.js';

const STATE_LABEL = { unstarted: 'Not started', inProgress: 'In progress', completed: 'Done: claim the reward', claimed: 'Done' };
const STATE_PILL = { unstarted: '', inProgress: 'accent', completed: 'warn', claimed: 'good' };

// How to get an item you're short of: the quickest method you can do now, with gathering included.
function howToGet(ctx, item, qty) {
  const index = memo('quests:index', levelsKey(ctx), () => producerIndex(ctx.gd, ctx.levels));
  const way = obtain(index, new Map(Object.entries(ctx.stock ?? {})), item, qty);
  if (way.short <= 0) return '';
  if (!way.method) return '<span class="warn-text">nothing you can do yet makes it</span>';
  const chain = [...way.needs.map((n) => n.method), way.method].map(methodLink).join(' → ');
  return `${chain} <span class="muted">(${duration(way.hours)})</span>`;
}

function goalLine(ctx, g) {
  const target = g.goal.method && ctx.gd.methodByKey.get(g.goal.method)
    ? methodLink(ctx.gd.methodByKey.get(g.goal.method))
    : g.goal.item
      ? itemLink(ctx, g.goal.item)
      : g.goal.enemy
        ? `<a href="#/lookup/enemy/${encodeURIComponent(g.goal.enemy)}">${esc(ctx.gd.enemyById.get(g.goal.enemy)?.name ?? g.goal.enemy)}</a>`
        : '';
  const label = esc(g.goal.label);
  return `<li><span>${g.done ? '✓ ' : ''}${label}${target && !g.goal.label.includes(target) ? ` <span class="muted small">· ${target}</span>` : ''}${g.goal.skill ? ` <span class="muted small">${esc(skillName(ctx, g.goal.skill))}</span>` : ''}</span><span class="num">${exact(Math.floor(g.progress))}/${exact(g.max)}</span></li>`;
}

function costLine(ctx, c, paid) {
  const short = Math.max(0, c.qty - c.have);
  return `<li><span>Hand in ${exact(c.qty)} ${itemLink(ctx, c.item)}${!paid && short > 0 ? `<span class="sub small">Short ${exact(short)}: ${howToGet(ctx, c.item, short)}</span>` : ''}</span><span class="num${!paid && short > 0 ? ' warn-text' : ''}">${paid ? 'Handed in' : `${exact(Math.min(c.have, c.qty))}/${exact(c.qty)}`}</span></li>`;
}

function currentQuest(ctx, s) {
  const q = s.quest;
  const tasks = s.tasks.map((t, i) => {
    const lines = [...t.goals.map((g) => goalLine(ctx, g)), ...t.costs.map((c) => costLine(ctx, c, t.paid)), ...t.task.currencyCosts.map((c) => `<li><span>Pay ${gp(c.qty)} ${esc(ctx.gd.currencyName(c.currency))}</span><span class="num">${t.paid ? 'Paid' : ''}</span></li>`)];
    return `<div class="quest-task${t.state === 'complete' ? ' done' : t.state === 'active' ? ' active' : ''}"><h4>Task ${i + 1}${t.state === 'complete' ? ' · done' : t.state === 'active' ? ' · now' : ''}</h4>${lines.length ? `<ul class="list-plain">${lines.join('')}</ul>` : '<p class="small muted">Talk to continue.</p>'}</div>`;
  });
  return card(`${esc(q.name)} <span class="pill accent">Step ${s.stepIndex + 1} of ${q.steps.length}</span>`, `
    <p class="small muted">${esc(s.step.description)}</p>
    ${tasks.join('')}`, ' style="margin-bottom:12px"');
}

function questRow(ctx, s) {
  const q = s.quest;
  const name = (id) => esc(ctx.gd.raw.quests.find((x) => x.id === id)?.name ?? id);
  let note = '';
  if (s.state === 'unstarted') {
    if (s.unreachable) note = `<span class="warn-text">Can't appear: it stays hidden until ${s.hiddenBy.map(name).join(', ')} is done, which needs this quest first.</span>`;
    else if (s.canStart) note = '<span class="accent-text">Ready to start</span>';
    else if (s.blockedBy.length) note = `Needs ${s.blockedBy.map(name).join(', ')} first`;
    else if (s.hiddenBy.length) note = `Appears after ${s.hiddenBy.map(name).join(', ')}`;
  }
  const rewards = [...q.rewards.items.map((r) => `${exact(r.qty)} ${itemLink(ctx, r.item)}`), ...q.rewards.currencies.map((c) => `${gp(c.qty)} ${esc(ctx.gd.currencyName(c.currency))}`)];
  return `<li><span><strong>${esc(q.name)}</strong> <span class="pill ${STATE_PILL[s.state]}">${STATE_LABEL[s.state]}</span><span class="sub small">${q.steps.length} steps${rewards.length ? ` · Rewards: ${rewards.join(', ')}` : ''}</span>${note ? `<span class="sub small">${note}</span>` : ''}</span></li>`;
}

export function quests(ctx) {
  const head = pageHead('Quests', 'Where you are in each quest, from your save, and what the current step still needs.');
  if (!ctx.save) return `${head}${noSaveCard(ctx)}`;
  if (!ctx.save.quests) return `${head}<div class="card empty"><h2>No quest progress in this save</h2><p>The companion couldn't find quest data in your save.</p></div>`;
  const all = questStatus(ctx.gd, ctx.save, { stock: ctx.stock });
  const active = all.filter((s) => s.state === 'inProgress' && s.step);
  const toClaim = all.filter((s) => s.state === 'completed');
  const next = all.filter((s) => s.state === 'unstarted');
  const done = all.filter((s) => s.state === 'claimed');
  return `${head}
    ${active.length ? active.map((s) => currentQuest(ctx, s)).join('') : `<div class="card" style="margin-bottom:12px"><p>No quest in progress.${next.some((s) => s.canStart) ? ` <strong>${esc(next.find((s) => s.canStart).quest.name)}</strong> is ready to start.` : ''}</p></div>`}
    ${toClaim.length ? card('Rewards to claim', `<ul class="list-plain">${toClaim.map((s) => questRow(ctx, s)).join('')}</ul>`, ' style="margin-bottom:12px"') : ''}
    <div class="grid two" style="align-items:start">
      ${card(`Still to do (${next.length})`, next.length ? `<ul class="list-plain">${next.map((s) => questRow(ctx, s)).join('')}</ul>` : '<p class="muted">Nothing left.</p>')}
      ${card(`Done (${done.length})`, done.length ? `<ul class="list-plain">${done.map((s) => questRow(ctx, s)).join('')}</ul>` : '<p class="muted">None yet.</p>')}
    </div>`;
}
