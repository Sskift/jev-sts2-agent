// The native option text is authoritative; this only makes its immediate HP
// consequence and the known next room explicit for a high-stakes camp choice.
export function campSurvivalFacts(state) {
  if (state.screen !== 'REST_SITE') return null;
  const player = state.decision_context?.player;
  const option = state.rest_site?.options?.find(option => option.option_id === 'HEAL' && option.is_enabled);
  const description = option?.description || '';
  const advertised = Number(description.match(/\((\d+)\)/)?.[1]
    ?? description.match(/\bHeal(?: for)?\s+(\d+)\s+HP\b/i)?.[1]);
  const effective = player && Number.isInteger(advertised)
    ? Math.max(0, Math.min(advertised, player.max_hp - player.hp)) : null;
  const map = state.decision_context?.map, coord = map?.current_coord;
  const current = map?.nodes?.find(node => node.col === coord?.col && node.row === coord?.row);
  const next = current?.children?.map(child => map.nodes.find(node => node.col === child.col && node.row === child.row));
  const knownNextIsBoss = Array.isArray(next) && next.length > 0 && next.every(node => node?.type === 'BOSS');
  return {
    healing: { hp_before: player?.hp ?? null, max_hp: player?.max_hp ?? null,
      advertised_hp_gain: Number.isInteger(advertised) ? advertised : null,
      effective_hp_gain: effective, hp_after: effective === null ? null : player.hp + effective,
      source: 'live rest option description; additional relic or event triggers are not projected' },
    next_room: { known_next_is_boss: knownNextIsBoss, boss: knownNextIsBoss ? map.boss ?? null : null,
      source: 'revealed current-act map edges only' }
  };
}
