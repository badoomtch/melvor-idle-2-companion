// Settings, in four tabs: General (your levels, where saves are read from, appearance), Alerts (what the
// companion tells you about, and how), Bonuses (what's counted in every rate) and About (version, how the
// numbers work, the stats file).
import { playerBonuses, playerCombatMods } from '/engine/gamedata.js';
import { MODELLED_BONUS_STATS } from '/engine/rates.js';
import { ago, badge, esc } from '/ui/format.js';
import { bonusText, card, pageHead, skillName } from './shared.js';
import { THEMES } from './topbar.js';

// ---------- General ----------

export function settings(ctx) {
  const { gd, state } = ctx;
  const st = state.status;
  const levelInputs = gd.skills
    .map((s) => `<label>${esc(s.name)} <input id="lvl-${s.id}" type="number" min="1" max="${gd.levelCap}" value="${state.manualLevels[s.id] ?? 1}" data-bind="manualLevel" data-skill="${s.id}"></label>`)
    .join('');
  const folders = (st?.saveDirs ?? []).map((d) => `<code>${esc(d)}</code>`).join(' ');
  const where = folders ? `<p class="small muted" style="margin-top:12px">Saves are read from ${folders}${st && !st.saveDirExists ? ' <span class="pill warn">not found</span>' : ''}</p>` : '';
  return `${pageHead('General')}
    ${card('Your levels', `<div class="segmented" role="group" aria-label="Level source" style="margin-bottom:12px">
        <button data-action="levelSource" data-value="save" aria-pressed="${state.levelSource === 'save'}">From my save</button>
        <button data-action="levelSource" data-value="manual" aria-pressed="${state.levelSource === 'manual'}">Enter by hand</button>
      </div>
      ${state.levelSource === 'manual'
        ? `${ctx.save ? '<p><button data-action="copyLevels">Copy levels from my save</button></p>' : ''}<div class="levels-grid">${levelInputs}</div>`
        : `<p class="small muted">Levels, XP and your bank are read from your save automatically. Switch to "Enter by hand" to plan without a save, or to try "what if" levels.</p>`}
      ${where}`)}
    ${card('Appearance', `<div class="theme-grid">${THEMES.map((t) => `<button class="theme-option" data-action="theme" data-value="${t.id}" aria-pressed="${state.theme === t.id}"><span class="swatches">${t.swatch.map((c) => `<span style="background:${c}"></span>`).join('')}</span><span>${esc(t.name)}</span></button>`).join('')}</div>`)}`;
}

// ---------- Alerts ----------

const alertSwitch = (key, on, text) => `<label class="inline-check setting-line"><input type="checkbox" data-action="alertToggle" data-key="${key}"${on ? ' checked' : ''}> <span>${text}</span></label>`;

export function alertsPage(ctx) {
  const { state } = ctx;
  const a = state.alerts;
  const what = card('What to tell you', `
    <h4 class="setting-head">Warnings</h4>
    ${alertSwitch('runningOut', a.runningOut, `Supplies will run out within <input id="alert-minutes" type="number" min="1" max="600" value="${a.minutes}" data-bind="alerts.minutes" style="width:5em"> minutes`)}
    ${alertSwitch('stopped', a.stopped, 'Nothing is training, XP stops coming in, or the game stops saving')}
    ${alertSwitch('ranch', a.ranch !== false, 'Ranch animals are hungry, sick or about to die of old age')}
    <h4 class="setting-head">Progress</h4>
    ${alertSwitch('planSteps', a.planSteps !== false, 'A step of your plan is done, and what comes next')}
    ${alertSwitch('harvests', a.harvests !== false, 'A farming plot is ready to harvest')}
    ${alertSwitch('rareFinds', a.rareFinds !== false, 'You find a rare item, and how rare it is (the Rare items page keeps a list)')}
    <p class="small muted setting-note">Level-ups and goals you reach always get a pop-up.</p>
    <h4 class="setting-head">Sound</h4>
    ${alertSwitch('sound', a.sound, 'A short tone when you run out of something or stop gaining XP, while this page is open')}`);
  const desktop = state.serverAlerts
    ? `<div class="server-alerts">
        <p><strong>Desktop notifications from the companion</strong><br><span class="small muted">Everything above arrives as a desktop notification while the companion runs, even with this page closed.</span></p>
        <button data-action="serverAlerts" aria-pressed="${state.serverAlerts.enabled}">${state.serverAlerts.enabled ? 'Turn off' : 'Turn on'}</button>
        <button class="link" data-action="testServerAlert" style="margin-left:12px">Send a test notification</button>
      </div>`
    : '';
  const fromPage = state.serverAlerts?.enabled
    ? ''
    : `<p class="small muted" style="margin-top:12px">${state.serverAlerts ? 'Or only from this page, while its tab is in the background:' : 'Desktop notifications from this page, while its tab is in the background:'}</p>
      ${'Notification' in window
        ? Notification.permission === 'denied'
          ? '<p class="small">Desktop notifications are blocked for this page in your browser settings.</p>'
          : `<button data-action="notify" aria-pressed="${state.notify && Notification.permission === 'granted'}">${state.notify && Notification.permission === 'granted' ? 'Turn off desktop notifications' : 'Turn on desktop notifications'}</button>`
        : '<p class="small">This browser doesn\'t support desktop notifications.</p>'}`;
  const how = card('How you get them', `<p class="small muted">Pop-ups show on this page, and warnings stay at the top of it until they're sorted.</p>
    ${desktop}${fromPage}
    <p style="margin-top:12px"><button class="link" data-action="testToast">Show a test pop-up on this page</button></p>`);
  return `${pageHead('Alerts', 'What the companion tells you about, and how.')}${what}${how}`;
}

// ---------- Bonuses ----------

// What the save shows you have, and whether it's counted in the rates.
export function bonusesPage(ctx) {
  const { gd, state } = ctx;
  const head = pageHead('Bonuses', 'Shop upgrades, toolbelt items, pets and Mastery Guild ranks from your save, counted in every rate.');
  if (!ctx.save) return `${head}${card('', '<p class="muted small">Load a save to count your shop upgrades, toolbelt items, pets and Mastery Guild ranks.</p>')}`;
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
  // What a bonus is limited to, by its game name: an animal or recipe ("Wild Chicken"), an area, spot or kind.
  const scopeName = (skill, scope) => Object.entries(scope).map(([k, v]) => (k === 'Recipe' ? gd.methodByKey.get(`${skill}/${v}`)?.name ?? v : v)).join(', ');
  const items = [...bySkill].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([skill, rows]) => {
    const sources = [...new Set([...rows.values()].flatMap((r) => [...r.sources]))];
    // Bonuses for the whole skill first; those for one animal, area or recipe grouped by it, and folded
    // away when there are more than two.
    const general = [...rows.values()].filter((r) => !r.scope || !Object.keys(r.scope).length).map((r) => esc(bonusText(r)));
    const scoped = new Map();
    for (const r of rows.values()) {
      if (!r.scope || !Object.keys(r.scope).length) continue;
      const name = scopeName(skill, r.scope);
      scoped.set(name, [...(scoped.get(name) ?? []), esc(bonusText({ ...r, scope: null }))]);
    }
    const lines = [...scoped].map(([name, texts]) => `<li><strong>${esc(name)}:</strong> ${texts.join(' · ')}</li>`).join('');
    const names = [...scoped.keys()];
    const forSome = !scoped.size
      ? ''
      : scoped.size <= 2
        ? `<ul class="bonus-scoped">${lines}</ul>`
        : `<details class="bonus-more"><summary>For ${esc(names.slice(0, 3).join(', '))}${names.length > 3 ? ` and ${names.length - 3} more` : ''}</summary><ul class="bonus-scoped">${lines}</ul></details>`;
    return `<div class="bonus-item"><div>${badge(skill, skillName(ctx, skill))} <strong>${esc(skillName(ctx, skill))}</strong></div>
      ${general.length ? `<div class="small">${general.join(' · ')}</div>` : ''}
      ${forSome ? `<div class="small">${forSome}</div>` : ''}
      <div class="small muted">From ${esc(sources.slice(0, 4).join(', '))}${sources.length > 4 ? ` and ${sources.length - 4} more` : ''}</div></div>`;
  });
  return `${head}
    ${card('', `<label class="inline-check"><input type="checkbox" data-action="useBonuses"${state.useBonuses ? ' checked' : ''}> Count my bonuses in every rate</label>
      <p class="small muted" style="margin-top:6px">Switch this off to see the game's base rates.${combatMods.length ? ` Fights also count ${combatMods.length} combat bonuses from prayers, combat potions and Mastery.` : ''} Bonuses the companion can't turn into rates yet aren't listed; your measured XP rate on Home includes everything.</p>`)}
    ${card(`What's counted <span class="muted small">· ${items.length} skills</span>`, items.length ? `<div class="bonus-grid">${items.join('')}</div>` : '<p class="muted small">None found yet.</p>')}`;
}

// ---------- About ----------

export function aboutPage(ctx) {
  const { gd, state } = ctx;
  const st = state.status;
  return `${pageHead('About')}
    ${card('Version', `<dl class="kv">
        <dt>Companion</dt><dd>${esc(st?.appVersion ?? '')}${updateLine(state, st)}</dd>
        <dt>Game data</dt><dd>${esc(st?.data?.source ?? gd.meta.source)} (built ${esc(new Date(gd.meta.generatedAt).toLocaleDateString())})${gd.meta.includeLocked ? ' · includes locked content' : ''}</dd>
        <dt>Level cap</dt><dd>${gd.levelCap}</dd>
      </dl>`)}
    ${card('How the numbers work', `<ul class="small">
        <li>Rates come straight from the game's own formulas (action time, success chance, drop tables, the XP curve).</li>
        <li>With a save loaded they include your shop upgrades, toolbelt tools and potions, pets, and (in combat) your gear and prayers: see <a href="#/bonuses">Bonuses</a>. Mastery Guild ranks are worked out from the tasks your save shows complete. Situational bonuses aren't counted yet; the "measured" rate from your saves includes everything.</li>
        <li>GP values use item sell prices. Profit subtracts materials and the food you eat to heal damage.</li>
        <li>Your save is only ever read, never changed, and nothing about it leaves your computer. The one thing the companion asks the internet is whether GitHub has a newer version, and you can turn that off above.</li>
      </ul>`)}
    ${ctx.save ? card('Help balance the game', `<p class="small muted">Saves a file with your levels, the game's own statistics, Mastery Guild progress, and how the companion's estimates compared with what you really got. It leaves out your character name. Nothing is sent anywhere: you choose whether to share the file.</p>
      <button data-action="exportStats">Save my stats file</button>`) : ''}`;
}

// Whether there's a newer release, and the switch for checking.
function updateLine(state, st) {
  const on = state.serverAlerts && state.serverAlerts.checkUpdates !== false;
  const u = st?.update;
  const status = !on ? 'Not checking for new versions' : u?.latest ? `<a href="${esc(u.latest.url)}" target="_blank" rel="noopener">Version ${esc(u.latest.version)} is out</a>` : u?.checkedAt ? `Up to date (checked ${esc(ago(u.checkedAt))})` : 'Checks GitHub for new versions';
  return ` <span class="muted small">· ${status}</span>${state.serverAlerts ? ` <button class="link" data-action="checkUpdates">${on ? 'Stop checking' : 'Check for new versions'}</button>` : ''}`;
}
