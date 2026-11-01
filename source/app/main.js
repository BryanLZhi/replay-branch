// Start-up: load the simulator, wait for Showdown's replay viewer, then open the sample replay it already shows.
import {$id, esc, setEngine} from './state.js';
import {attachToEmbed} from './viewer.js';
import {onKey} from './navigation.js';
import {loadText, wireDialogs} from './load.js';

// Hover tooltips for older generations use Showdown's teambuilder tables (16 MB); fetch them once the page is usable.
const TEAMBUILDER_TABLES = 'https://play.pokemonshowdown.com/data/teambuilder-tables.js?a7';

async function boot() {
  try {
    setEngine(await import('./engine.js'));
    await until(() => window.Replays && Replays.battle && window.Battle && window.Dex);
    attachToEmbed();
    wireDialogs();
    document.addEventListener('keydown', onKey);
    await loadText(await fetch('sample.json').then(r => r.text()), {shown: true});
    (window.requestIdleCallback || (f => setTimeout(f, 1500)))(() => {
      const s = document.createElement('script'); s.src = TEAMBUILDER_TABLES; document.head.appendChild(s);
    });
  } catch (e) {
    console.error(e);
    const el = $id('pickSec'); el.hidden = false;
    el.innerHTML = `<p class="rb-err">Could not start: ${esc(e.message || e)}</p>`;
  }
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

boot();
