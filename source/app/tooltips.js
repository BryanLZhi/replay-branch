// Showdown's own tooltips (battle-tooltips.js) on the move picker's buttons, as in a real battle.
// Buttons carry data-tooltip="move|<index in the request>" or "switchpokemon|<index in the team>", and data-note for an
// extra line ("Guessed", "Used in the replay"), and moves data-calc with the damage calc's result.
import {S, esc} from './state.js';

let tips = null;
let request = null;   // {si, req}: whose choice the picker shows

export function listenForTooltips(el) {
  tips = new BattleTooltips(S.psb);
  tips.showTooltip = showTooltip;
  tips.listen(el);
}
export function setTooltipRequest(si, req) { request = req ? {si, req} : null; BattleTooltips.hideTooltip(); }

// A request's Pokemon as Showdown's client keeps them (its "server Pokemon").
function serverPokemon(p) {
  const out = {...p};
  S.psb.parseDetails(p.ident.slice(4), p.ident, p.details, out);
  S.psb.parseHealth(p.condition, out);
  return out;
}

function showTooltip(elem) {
  if (!request) return false;
  const [type, n] = elem.dataset.tooltip.split('|');
  const {si, req} = request;
  tips.battle = S.psb;
  let html;
  try {
    if (type === 'move') {
      const active = S.psb.sides[si].active[0];
      if (!active) return false;
      const move = req.active[0].moves[n];
      html = tips.showMoveTooltip(S.psb.dex.moves.get(move.id || move.move), 'move', active, serverPokemon(req.side.pokemon.find(p => p.active)));
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
