// Home: where you are (your character, what you're doing, your supplies) and your plan. It replaces the
// old Overview and What next pages, whose addresses still lead here.
import { nowNotice } from './next.js';
import { overviewTop, warmBestFights } from './overview.js';
import { routeCard } from './route-ui.js';

export function home(ctx) {
  // The skill cards' best fights take a few seconds: started now, quietly, so they're ready.
  warmBestFights(ctx);
  return `${overviewTop(ctx)}<div style="margin-top:12px">${nowNotice(ctx)}${routeCard(ctx)}</div>`;
}
