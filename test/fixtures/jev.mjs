// Strategy assertions operate on the decoded JSON protocol; transport tests
// separately inspect the exact HTTP body and round-trip its state text.
export function parseJevRequest(body) {
  const payload = JSON.parse(body);
  if (typeof payload.state === 'string') payload.state = JSON.parse(payload.state);
  return payload;
}
