/**
 * Google OAuth for BigQuery without the Node SDK: service-account JWT (RS256) signed with
 * WebCrypto, exchanged for an access token. Runs on Node ≥20 and Cloudflare Workers.
 */

export const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

export type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
};

export type TokenProvider = {
  getToken(): Promise<string>;
  principal: string;
};

export function parseServiceAccount(raw: string): ServiceAccountKey {
  const text = raw.trim();
  let json: string = text;
  if (!text.startsWith("{")) {
    try {
      json = atob(text);
    } catch {
      throw new Error("BigQuery credentials_json must be JSON or base64-encoded JSON");
    }
  }
  let parsed: Partial<ServiceAccountKey> & { type?: string };
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`BigQuery credentials_json is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("BigQuery credentials_json must be a service-account key (client_email + private_key)");
  }
  return parsed as ServiceAccountKey;
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(text: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(text));
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function signServiceAccountJwt(
  key: ServiceAccountKey,
  scope: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: key.client_email,
    scope,
    aud: key.token_uri ?? DEFAULT_TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(JSON.stringify(claims))}`;
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(key.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64UrlFromBytes(new Uint8Array(sig))}`;
}

// Module-scoped so Workers isolates / Node processes reuse tokens across requests.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function serviceAccountTokenProvider(
  key: ServiceAccountKey,
  fetchImpl: typeof fetch = fetch,
  scope = BIGQUERY_SCOPE,
): TokenProvider {
  const cacheKey = `${key.client_email}|${scope}`;
  return {
    principal: key.client_email,
    async getToken() {
      const hit = tokenCache.get(cacheKey);
      if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;
      const assertion = await signServiceAccountJwt(key, scope);
      const res = await fetchImpl(key.token_uri ?? DEFAULT_TOKEN_URI, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      });
      const body = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (!res.ok || !body.access_token) {
        throw new Error(
          `Google token exchange failed (${res.status}): ${body.error_description ?? body.error ?? "no access_token"}`,
        );
      }
      tokenCache.set(cacheKey, {
        token: body.access_token,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      });
      return body.access_token;
    },
  };
}

export function staticTokenProvider(token: string): TokenProvider {
  return { principal: "access_token", getToken: async () => token };
}

export function clearTokenCache(): void {
  tokenCache.clear();
}
