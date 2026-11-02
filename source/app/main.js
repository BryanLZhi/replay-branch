// Start-up: show the page the address asks for at once (the landing page needs nothing else), while the simulator and
// Showdown's replay viewer load.
import {S, $id, setEngine} from './state.js';
import {attachToEmbed} from './viewer.js';
import {onKey, onOutsideClick} from './navigation.js';
import {route, wireDialogs} from './load.js';
import {wireLanding} from './landing.js';
import {listenForTooltips} from './tooltips.js';
import {wireChapters} from './chapters.js';

// Hover tooltips for older generations use Showdown's teambuilder tables (16 MB); fetch them once the page is usable.
const TEAMBUILDER_TABLES = 'https://play.pokemonshowdown.com/data/teambuilder-tables.js?a7';

async function loadViewer() {
  setEngine(await import('./engine.js'));
  await until(() => window.Replays && Replays.battle && window.Battle && window.Dex);
  attachToEmbed();
  listenForTooltips($id('pickSec'));
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', onOutsideClick);
  (window.requestIdleCallback || (f => setTimeout(f, 1500)))(() => {
    const s = document.createElement('script'); s.src = TEAMBUILDER_TABLES; document.head.appendChild(s);
  });
}

function until(test, ms = 60000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let ok = false; try { ok = test(); } catch {}
      if (ok) resolve();
      else if (Date.now() - t0 > ms) reject(new Error('Showdown did not load (check your connection).'));
      else setTimeout(tick, 100);
    };
    tick();
  });
}

S.ready = loadViewer();
S.ready.catch(e => {
  console.error(e);
  $id('openErr').textContent = `Could not start: ${e.message || e}`;
});
wireDialogs();
wireLanding();
wireChapters();
$id('home').onclick = e => { e.preventDefault(); history.pushState(null, '', location.pathname); route(); };
window.addEventListener('popstate', route);
route();
