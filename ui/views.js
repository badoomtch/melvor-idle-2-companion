// Page renderers live in ui/pages/ (one module per page); this picks the page for the current route and
// puts its section's tabs above it.
import { accuracy } from './pages/accuracy.js';
import { away } from './pages/away.js';
import { bank } from './pages/bank.js';
import { calculators } from './pages/calculators.js';
import { combat } from './pages/combat.js';
import { completion } from './pages/completion.js';
import { goals } from './pages/goals.js';
import { home } from './pages/home.js';
import { quests } from './pages/quests.js';
import { historyView } from './pages/history.js';
import { lookupView } from './pages/lookup.js';
import { masteryPage } from './pages/mastery.js';
import { money } from './pages/money.js';
import { rarePage } from './pages/rare.js';
import { aboutPage, alertsPage, bonusesPage, settings } from './pages/settings.js';
import { setCurrentGd } from './pages/shared.js';
import { shopPlanner } from './pages/shop.js';
import { skills } from './pages/skills.js';
import { slayer } from './pages/slayer.js';
import { toolbeltPage } from './pages/toolbelt-ui.js';
import { pageOf, sectionTabs } from './pages/topbar.js';

export { renderMini } from './pages/mini.js';
export { AUTOSAVE_MS, renderLivePill, renderSaveBar, renderTabs, renderTopAlerts, TABS, THEMES, topAlerts } from './pages/topbar.js';

const VIEWS = { home, away, skills, toolbelts: toolbeltPage, mastery: masteryPage, money, bank, shop: shopPlanner, combat, slayer, calculators, lookup: lookupView, rare: rarePage, goals, quests, history: historyView, completion, accuracy, settings, alerts: alertsPage, bonuses: bonusesPage, about: aboutPage };

export function renderView(ctx) {
  setCurrentGd(ctx.gd);
  const route = ctx.state.route;
  const view = VIEWS[pageOf(route.tab)] ?? home;
  return `${sectionTabs(route, ctx)}${view(ctx, route.args)}`;
}
