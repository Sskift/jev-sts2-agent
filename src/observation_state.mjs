// Native v0.111.0 HappyFlower.TurnsSeen is modulo 3. DisplayAmount briefly
// returns 3 during DoActivateVisuals even though TurnsSeen is already 0.
// Keep the gameplay counter in decision facts; raw mod snapshots retain the
// animation value. Energy, status and all other relic fields remain intact.
export function canonicalRelics(relics) {
  return relics?.map(relic => relic.id === 'HAPPY_FLOWER' && relic.counter === 3
    ? { ...relic, counter: 0 } : relic);
}

// Only unordered piles and known presentation fields are canonicalized.
// Hand positions, discard order and action/history sequences stay ordered.
export function canonicalObservation(state) {
  const copy = structuredClone(state);
  delete copy.timestamp;
  if (copy.combat?.draw_pile) copy.combat.draw_pile.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  for (const player of [copy.decision_context?.player, copy.combat?.player]) {
    if (Array.isArray(player?.relics)) player.relics = canonicalRelics(player.relics);
  }
  return copy;
}
