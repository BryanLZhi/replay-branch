// Showdown's own tooltips (battle-tooltips.js) on the move picker's buttons, as in a real battle.
// Buttons carry data-tooltip="move|<index in the request>|<zmove or maxmove when shown as one>" or "switchpokemon|<index in the team>", and data-note for an
// extra line ("Guessed", "Used in the replay"), and moves data-calc with the damage calc's result.
import {S, esc} from './state.js';

let tips = null;
let request = null;   // {si, req, place}: whose choice the picker shows

export function listenForTooltips(el) {
  tips = new BattleTooltips(S.psb);
  tips.showTooltip = showTooltip;
  tips.listen(el);
}
export function setTooltipRequest(si, req, place = 0) { request = req ? {si, req, place} : null; BattleTooltips.hideTooltip(); }

// A request's Pokemon as Showdown's client keeps them (its "server Pokemon").
function serverPokemon(p) {
  const out = {...p};
  S.psb.parseDetails(p.ident.slice(4), p.ident, p.details, out);
  S.psb.parseHealth(p.condition, out);
  return out;
}

function showTooltip(elem) {
  if (!request) return false;
  const [type, n, as] = elem.dataset.tooltip.split('|');
  const {si, req, place} = request;
  tips.battle = S.psb;
  let html;
  try {
    if (type === 'move') {
      const active = S.psb.sides[si].active[place];
      if (!active) return false;
      const move = req.active[place].moves[n];
      html = tips.showMoveTooltip(S.psb.dex.moves.get(move.id || move.move), as || 'move', active, serverPokemon(req.side.pokemon[place]));
    } else {
      html = tips.showPokemonTooltip(null, serverPokemon(req.side.pokemon[n]));
    }
  } catch (e) {
    console.error(e);
    return false;
  }
  if (elem.dataset.calc) html += `<p class="tooltip-section">${esc(elem.dataset.calc)}</p>`;
  if (elem.dataset.note) html += `<p class="tooltip-section">${esc(elem.dataset.note)}</p>`;
  tips.placeTooltip(html, elem, false, type === 'move' ? 'move' : 'pokemon');
  return true;
}
