export function authorizeBearer(
  expected: string | undefined,
  authorizationHeader: string | null | undefined,
): boolean {
  if (!expected) return false;
  if (!authorizationHeader) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!m) return false;
  return timingSafeEqual(m[1]!, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
