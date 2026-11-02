// Showdown's team validator, bundled on its own into validator.js (with the learnsets and legality tables engine.js leaves
// out), and loaded only when a new battle is started.
import {Dex, TeamValidator, Teams} from '@pkmn/sim';

// What Showdown's server says to a team it rejects in the format (its popup), for each team; null for a team it takes.
// (a set without an ability gets the species' first, as on its way from Showdown's client to the server)
export function rejections(formatid, texts) {
  const validator = TeamValidator.get(formatid);
  return texts.map(text => {
    const team = (Teams.import(text) || []).map(s => s.ability ? s : {...s, ability: Dex.species.get(s.species).abilities['0'] || ''});
    const problems = validator.validateTeam(team);
    return problems?.length ? 'Your team was rejected for the following reasons:\n\n- ' + problems.join('\n').replace(/\n/g, '\n- ') : null;
  });
}
