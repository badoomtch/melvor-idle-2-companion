// Page renderers live in ui/pages/ (one module per page); this picks the page for the current route.
import { accuracy } from './pages/accuracy.js';
import { away } from './pages/away.js';
import { bank } from './pages/bank.js';
import { calculators } from './pages/calculators.js';
import { combat } from './pages/combat.js';
import { completion } from './pages/completion.js';
import { goals } from './pages/goals.js';
import { quests } from './pages/quests.js';
import { historyView } from './pages/history.js';
import { lookupView } from './pages/lookup.js';
import { masteryPage } from './pages/mastery.js';
import { money } from './pages/money.js';
import { next } from './pages/next.js';
import { overview } from './pages/overview.js';
import { rarePage } from './pages/rare.js';
import { settings } from './pages/settings.js';
import { setCurrentGd } from './pages/shared.js';
import { shopPlanner } from './pages/shop.js';
import { skills } from './pages/skills.js';
import { slayer } from './pages/slayer.js';
import { toolbeltPage } from './pages/toolbelt-ui.js';

export { renderMini } from './pages/mini.js';
export { AUTOSAVE_MS, renderLivePill, renderSaveBar, renderTabs, renderTopAlerts, TABS, THEMES, topAlerts } from './pages/topbar.js';

const VIEWS = { overview, next, away, skills, toolbelts: toolbeltPage, mastery: masteryPage, money, bank, shop: shopPlanner, combat, slayer, calculators, lookup: lookupView, rare: rarePage, goals, quests, history: historyView, completion, accuracy, settings };

export function renderView(ctx) {
  setCurrentGd(ctx.gd);
  const view = VIEWS[ctx.state.route.tab] ?? overview;
  return view(ctx, ctx.state.route.args);
}
