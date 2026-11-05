// Settings: levels source, bonuses, demo only, appearance, alerts and notifications.
import { playerBonuses, playerCombatMods } from '/engine/gamedata.js';
import { MODELLED_BONUS_STATS } from '/engine/rates.js';
import { ago, badge, esc, exact } from '/ui/format.js';
import { bonusText, card, pageHead, skillName } from './shared.js';
import { THEMES } from './topbar.js';

// ---------- Bonuses ----------

// What the save shows you have, and whether it's counted in the rates.
function bonusesCard(ctx) {
  const { gd, state } = ctx;
  if (!ctx.save) return card('Bonuses', '<p class="muted small">Load a save to count your shop upgrades, toolbelt items, pets and Mastery Guild ranks.</p>');
  const effects = playerBonuses(gd, ctx.save).filter((e) => MODELLED_BONUS_STATS.has(e.stat));
  const combatMods = playerCombatMods(gd, ctx.save);
  const bySkill = new Map();
  for (const e of effects) {
    const key = `${e.stat}|${JSON.stringify(e.scope ?? {})}`;
    const skill = bySkill.get(e.skill) ?? new Map();
    const row = skill.get(key) ?? { ...e, value: 0, sources: new Set() };
    row.value += e.value;
    row.sources.add(e.source);
    skill.set(key, row);
    bySkill.set(e.skill, skill);
  }
  const rows = [...bySkill].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([skill, rowsForSkill]) => `<li><span>${badge(skill, skillName(ctx, skill))} <strong>${esc(skillName(ctx, skill))}</strong><span class="sub small">${[...rowsForSkill.values()].map((r) => esc(bonusText(r))).join(' · ')}</span><span class="sub muted small">From ${esc([...new Set([...rowsForSkill.values()].flatMap((r) => [...r.sources]))].slice(0, 6).join(', '))}</span></span></li>`);
  return card('Bonuses', `<label class="inline-check"><input type="checkbox" data-action="useBonuses"${state.useBonuses ? ' checked' : ''}> Count my bonuses in every rate</label>
    <p class="small muted" style="margin:6px 0 8px">From your save: shop upgrades you've bought, tools and potions in your toolbelts, pets you've found and Mastery Guild ranks you've reached${combatMods.length ? `, plus ${combatMods.length} combat bonuses from prayers, combat potions and mastery` : ''}. Bonuses the companion can't turn into rates yet aren't listed; the measured XP rate on the Overview includes everything.</p>
    ${rows.length ? `<ul class="list-plain">${rows.join('')}</ul>` : '<p class="muted small">None found yet.</p>'}`);
}

// ---------- Demo ----------

// Recommend only what the Steam demo has: automatic (from the save), on or off.
function demoCard(ctx) {
  const { gd, state } = ctx;
  if (!gd.demo) return '';
  const fromSave = ctx.save?.header?.isDemo;
  const option = (value, label) => `<button data-action="demoOnly" data-value="${value}" aria-pressed="${state.demoOnly === value}">${label}</button>`;
  const auto = ctx.save ? `your save is ${fromSave ? '' : 'not '}from the demo, so it's ${fromSave ? 'on' : 'off'}` : 'no save loaded, so it\'s off';
  const skills = [...gd.demo.skills].map((id) => esc(gd.skillName(id))).join(', ');
  const share = (kind, all) => `${exact(all.length - gd.demo[kind].size)} of ${exact(all.length)}`;
  return card('Demo', `<div class="segmented" role="group" aria-label="Only what the demo has" style="margin-bottom:12px">
      ${option('auto', 'Automatic')}${option('on', 'Demo only')}${option('off', 'Everything')}
    </div>
    <p class="small muted">With demo only on, training methods, enemies, areas, dungeons, shop purchases and gear the Steam demo doesn't have are never recommended, and show as "Not in demo". Automatic: ${auto}.</p>
    <p class="small muted">The demo has ${share('methods', gd.methods)} training methods, ${share('enemies', gd.enemies)} enemies and ${share('items', Object.keys(gd.items))} items${skills ? `; ${skills} aren't in it at all` : ''}. From the demo's own data (version ${esc(gd.demo.source?.gameVersion ?? '?')}), via <a href="https://github.com/knsk45/melvor-idle-2-tools" target="_blank" rel="noopener">melvor-idle-2-tools</a>.</p>`);
}

// ---------- Settings ----------

export function settings(ctx) {
  const { gd, state } = ctx;
  const st = state.status;
  const levelInputs = gd.skills
    .map((s) => `<label>${esc(s.name)} <input id="lvl-${s.id}" type="number" min="1" max="${gd.levelCap}" value="${state.manualLevels[s.id] ?? 1}" data-bind="manualLevel" data-skill="${s.id}"></label>`)
    .join('');
  return `${pageHead('Settings')}
    ${card('Your levels', `<div class="segmented" role="group" aria-label="Level source" style="margin-bottom:12px">
        <button data-action="levelSource" data-value="save" aria-pressed="${state.levelSource === 'save'}">From my save</button>
        <button data-action="levelSource" data-value="manual" aria-pressed="${state.levelSource === 'manual'}">Enter by hand</button>
      </div>
      ${state.levelSource === 'manual'
        ? `${ctx.save ? '<p><button data-action="copyLevels">Copy levels from my save</button></p>' : ''}<div class="levels-grid">${levelInputs}</div>`
        : `<p class="small muted">Levels, XP and your bank are read from your save automatically. Switch to "Enter by hand" to plan without a save, or to try "what if" levels.</p>`}`)}
    ${card('Appearance', `<div class="theme-grid">${THEMES.map((t) => `<button class="theme-option" data-action="theme" data-value="${t.id}" aria-pressed="${state.theme === t.id}"><span class="swatches">${t.swatch.map((c) => `<span style="background:${c}"></span>`).join('')}</span><span>${esc(t.name)}</span></button>`).join('')}</div>`)}
    ${bonusesCard(ctx)}
    ${demoCard(ctx)}
    ${card('Alerts', `<p class="small muted">Pop-ups (and desktop notifications, if they're on) while the game runs.</p>
      <label class="inline-check"><input type="checkbox" data-action="alertToggle" data-key="runningOut"${state.alerts.runningOut ? ' checked' : ''}> Warn when supplies will run out within <input id="alert-minutes" type="number" min="1" max="600" value="${state.alerts.minutes}" data-bind="alerts.minutes" style="width:5em"> minutes</label>
      <label class="inline-check" style="margin-top:8px"><input type="checkbox" data-action="alertToggle" data-key="stopped"${state.alerts.stopped ? ' checked' : ''}> Warn when nothing is training, progress stalls, or the game stops saving</label>
      <label class="inline-check" style="margin-top:8px"><input type="checkbox" data-action="alertToggle" data-key="planSteps"${state.alerts.planSteps !== false ? ' checked' : ''}> Say when a step of your plan (What next) is done, and what's next</label>
      <label class="inline-check" style="margin-top:8px"><input type="checkbox" data-action="alertToggle" data-key="harvests"${state.alerts.harvests !== false ? ' checked' : ''}> Say when a farming plot is ready to harvest</label>
      <label class="inline-check" style="margin-top:8px"><input type="checkbox" data-action="alertToggle" data-key="ranch"${state.alerts.ranch !== false ? ' checked' : ''}> Warn when ranch animals are hungry, sick or about to die of old age</label>
      <label class="inline-check" style="margin-top:8px"><input type="checkbox" data-action="alertToggle" data-key="rareFinds"${state.alerts.rareFinds !== false ? ' checked' : ''}> Say when you find a rare item, and how rare it is (the Rare items page keeps a list)</label>
      <label class="inline-check" style="margin-top:8px"><input type="checkbox" data-action="alertToggle" data-key="sound"${state.alerts.sound ? ' checked' : ''}> Play a short tone when you run out of something or stop gaining XP (while this page is open)</label>`)}
    ${card('Notifications', `<p class="small muted">A pop-up appears here when you level up or reach a goal.</p>
      ${state.serverAlerts ? `<div class="server-alerts">
        <p><strong>Desktop notifications from the companion</strong><br><span class="small muted">The level-ups, goals and warnings above arrive as desktop notifications while the companion runs, even with this page closed.</span></p>
        <button data-action="serverAlerts" aria-pressed="${state.serverAlerts.enabled}">${state.serverAlerts.enabled ? 'Turn off' : 'Turn on'}</button>
        <button class="link" data-action="testServerAlert" style="margin-left:12px">Send a test notification</button>
      </div>` : ''}
      ${state.serverAlerts?.enabled ? '' : `<p class="small muted" style="margin-top:12px">Or only from this page, while its tab is in the background:</p>
      ${'Notification' in window
        ? Notification.permission === 'denied'
          ? '<p class="small">Desktop notifications are blocked for this page in your browser settings.</p>'
          : `<button data-action="notify" aria-pressed="${state.notify && Notification.permission === 'granted'}">${state.notify && Notification.permission === 'granted' ? 'Turn off desktop notifications' : 'Turn on desktop notifications'}</button>`
        : '<p class="small">This browser doesn\'t support desktop notifications.</p>'}`}
      <p style="margin-top:12px"><button class="link" data-action="testToast">Show a test pop-up on this page</button></p>`)}
    ${ctx.save ? card('Help balance the game', `<p class="small muted">Saves a file with your levels, the game's own statistics, Mastery Guild progress, and how the companion's estimates compared with what you really got. It leaves out your character name. Nothing is sent anywhere: you choose whether to share the file.</p>
      <button data-action="exportStats">Save my stats file</button>`) : ''}
    ${card('About', `<dl class="kv">
        <dt>Version</dt><dd>${esc(st?.appVersion ?? '')}${updateLine(state, st)}</dd>
        <dt>Game data</dt><dd>${esc(st?.data?.source ?? gd.meta.source)} (built ${esc(new Date(gd.meta.generatedAt).toLocaleDateString())})${gd.meta.includeLocked ? ' · includes locked content' : ''}</dd>
        <dt>Save folders</dt><dd>${(st?.saveDirs ?? []).map((d) => `<code>${esc(d)}</code>`).join('<br>')}${st && !st.saveDirExists ? ' <span class="pill warn">not found</span>' : ''}</dd>
        <dt>Level cap</dt><dd>${gd.levelCap}</dd>
      </dl>`)}
    ${card('How the numbers work', `<ul class="small">
        <li>Rates come straight from the game's own formulas (action time, success chance, drop tables, the XP curve).</li>
        <li>With a save loaded they include your shop upgrades, toolbelt tools and potions, pets, and (in combat) your gear and prayers (see Bonuses above). Mastery Guild ranks are worked out from the tasks your save shows complete. Situational bonuses aren't counted yet; the "measured" rate from your saves includes everything.</li>
        <li>GP values use item sell prices. Profit subtracts materials and the food you eat to heal damage.</li>
        <li>Your save is only ever read, never changed, and nothing about it leaves your computer. The one thing the companion asks the internet is whether GitHub has a newer version, and you can turn that off under About.</li>
      </ul>`)}`;
}

// Whether there's a newer release, and the switch for checking.
function updateLine(state, st) {
  const on = state.serverAlerts && state.serverAlerts.checkUpdates !== false;
  const u = st?.update;
  const status = !on ? 'Not checking for new versions' : u?.latest ? `<a href="${esc(u.latest.url)}" target="_blank" rel="noopener">Version ${esc(u.latest.version)} is out</a>` : u?.checkedAt ? `Up to date (checked ${esc(ago(u.checkedAt))})` : 'Checks GitHub for new versions';
  return ` <span class="muted small">· ${status}</span>${state.serverAlerts ? ` <button class="link" data-action="checkUpdates">${on ? 'Stop checking' : 'Check for new versions'}</button>` : ''}`;
}
