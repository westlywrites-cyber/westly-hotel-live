// ══════════════════════════════════════════════════════════════════════════
// Workers-compatible replacement for `firebase-admin`.
//
// `firebase-admin`'s Firestore client talks gRPC over Node's `net`/`tls`
// modules, and its Auth/App-Check pieces lean on `google-auth-library`,
// which assumes a Node runtime. None of that exists in the Cloudflare
// Workers V8 isolate, so the package cannot be used here as-is (see the
// migration notes for details on why "just add a polyfill" doesn't work).
//
// This file re-implements exactly the operations this project's functions
// use — nothing more — as plain `fetch()` calls against Google's public
// REST APIs (Firestore v1, Identity Toolkit v1, FCM v1), authenticated
// with a short-lived OAuth2 access token minted from the same service
// account JSON already used by FIREBASE_SERVICE_ACCOUNT_KEY. No new
// credentials are needed.
// ══════════════════════════════════════════════════════════════════════════

export interface Env {
  FIREBASE_SERVICE_ACCOUNT_KEY: string;
  FIREBASE_DATABASE_URL?: string;
  [key: string]: unknown;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

// ── Service account (parsed once per isolate) ───────────────────────────────
let cachedServiceAccount: ServiceAccount | null = null;

function getServiceAccount(env: Env): ServiceAccount {
  if (cachedServiceAccount) return cachedServiceAccount;
  const raw = env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_KEY is not set. Add the same base64-encoded " +
        "service account JSON you used on Netlify to Cloudflare Pages → " +
        "Settings → Environment variables → Secrets."
    );
  }
  const json = JSON.parse(atob(raw));
  if (!json.project_id || !json.client_email || !json.private_key) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY is missing project_id, client_email, or private_key.");
  }
  cachedServiceAccount = json;
  return json;
}

// ── base64url + PEM helpers ──────────────────────────────────────────────────
function base64UrlFromBytes(bytes: ArrayBuffer): string {
  let binary = "";
  new Uint8Array(bytes).forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(str: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(str).buffer);
}

function bytesFromBase64Url(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

let cachedPrivateKey: CryptoKey | null = null;

async function importServiceAccountPrivateKey(sa: ServiceAccount): Promise<CryptoKey> {
  if (cachedPrivateKey) return cachedPrivateKey;
  cachedPrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return cachedPrivateKey;
}

async function signJwtRS256(header: object, payload: object, sa: ServiceAccount): Promise<string> {
  const key = await importServiceAccountPrivateKey(sa);
  const signingInput = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64UrlFromBytes(signature)}`;
}

// ── OAuth2 access token (cached per-isolate, refreshed ~5 min before expiry) ─
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(env: Env, scopes: string[]): Promise<string> {
  const scopeKey = scopes.join(" ");
  const cached = tokenCache.get(scopeKey);
  if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;

  const sa = getServiceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwtRS256(
    { alg: "RS256", typ: "JWT" },
    {
      iss: sa.client_email,
      sub: sa.client_email,
      aud: "https://oauth2.googleapis.com/token",
      scope: scopeKey,
      iat: now,
      exp: now + 3600,
    },
    sa
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to mint Google access token: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(scopeKey, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

const SCOPE_DATASTORE = "https://www.googleapis.com/auth/datastore";
const SCOPE_IDENTITY = "https://www.googleapis.com/auth/identitytoolkit";
const SCOPE_FCM = "https://www.googleapis.com/auth/firebase.messaging";

// ══════════════════════════════════════════════════════════════════════════
// Firestore v1 REST — minimal client covering get/query/create/set/update/add
// ══════════════════════════════════════════════════════════════════════════

export type FirestoreValue =
  | string
  | number
  | boolean
  | null
  | Date
  | FirestoreValue[]
  | { [key: string]: FirestoreValue };

interface RawValue {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  stringValue?: string;
  timestampValue?: string;
  arrayValue?: { values?: RawValue[] };
  mapValue?: { fields?: Record<string, RawValue> };
}

function encodeValue(v: FirestoreValue): RawValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  return { mapValue: { fields: encodeFields(v as Record<string, FirestoreValue>) } };
}

function decodeValue(v: RawValue): any {
  if (!v || "nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return new Date(v.timestampValue!);
  if ("arrayValue" in v) return (v.arrayValue?.values || []).map(decodeValue);
  if ("mapValue" in v) return decodeFields(v.mapValue?.fields || {});
  return null;
}

function encodeFields(obj: Record<string, FirestoreValue>): Record<string, RawValue> {
  const out: Record<string, RawValue> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = encodeValue(v);
  return out;
}

function decodeFields(fields: Record<string, RawValue>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

function docBaseUrl(env: Env): string {
  const sa = getServiceAccount(env);
  return `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
}

async function firestoreFetch(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken(env, [SCOPE_DATASTORE]);
  return fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
}

export interface FirestoreDoc {
  id: string;
  exists: boolean;
  data(): Record<string, any>;
}

/** Equivalent of adminDb.collection(coll).doc(id).get() */
export async function fsGet(env: Env, collection: string, id: string): Promise<FirestoreDoc> {
  const res = await firestoreFetch(env, `${docBaseUrl(env)}/${collection}/${encodeURIComponent(id)}`);
  if (res.status === 404) {
    return { id, exists: false, data: () => ({}) };
  }
  if (!res.ok) throw new Error(`Firestore get(${collection}/${id}) failed: ${res.status} ${await res.text()}`);
  const doc = (await res.json()) as { fields?: Record<string, RawValue> };
  const fields = decodeFields(doc.fields || {});
  return { id, exists: true, data: () => fields };
}

export interface WhereClause {
  field: string;
  op: "==" | "in";
  value: FirestoreValue | FirestoreValue[];
}

/**
 * Equivalent of adminDb.collection(coll).where(...).where(...).limit(n).get()
 * All provided clauses are AND-ed together (the only combination this
 * project needs).
 */
export async function fsQuery(
  env: Env,
  collection: string,
  where: WhereClause[],
  opts: { limit?: number } = {}
): Promise<FirestoreDoc[]> {
  const filters = where.map((w) => ({
    fieldFilter: {
      field: { fieldPath: w.field },
      op: w.op === "in" ? "IN" : "EQUAL",
      value: w.op === "in" ? { arrayValue: { values: (w.value as FirestoreValue[]).map(encodeValue) } } : encodeValue(w.value as FirestoreValue),
    },
  }));

  const structuredQuery: Record<string, unknown> = { from: [{ collectionId: collection }] };
  if (filters.length === 1) structuredQuery.where = filters[0];
  else if (filters.length > 1) structuredQuery.where = { compositeFilter: { op: "AND", filters } };
  if (opts.limit) structuredQuery.limit = opts.limit;

  const res = await firestoreFetch(env, `${docBaseUrl(env)}:runQuery`, {
    method: "POST",
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw new Error(`Firestore query(${collection}) failed: ${res.status} ${await res.text()}`);
  const rows = (await res.json()) as Array<{ document?: { name: string; fields?: Record<string, RawValue> } }>;

  return rows
    .filter((r) => r.document)
    .map((r) => {
      const name = r.document!.name;
      const id = name.substring(name.lastIndexOf("/") + 1);
      const fields = decodeFields(r.document!.fields || {});
      return { id, exists: true, data: () => fields };
    });
}

/**
 * Equivalent of adminDb.collection(coll).doc(id).create(data) — atomically
 * fails (returns false) if a document already exists at that id, exactly
 * like the Admin SDK's `.create()` used for idempotent task-queue writes.
 */
export async function fsCreate(env: Env, collection: string, id: string, data: Record<string, FirestoreValue>): Promise<boolean> {
  const res = await firestoreFetch(env, `${docBaseUrl(env)}:commit`, {
    method: "POST",
    body: JSON.stringify({
      writes: [
        {
          update: { name: `${docBaseUrl(env)}/${collection}/${id}`, fields: encodeFields(data) },
          currentDocument: { exists: false },
        },
      ],
    }),
  });
  if (res.status === 409) return false; // ALREADY_EXISTS
  if (!res.ok) throw new Error(`Firestore create(${collection}/${id}) failed: ${res.status} ${await res.text()}`);
  return true;
}

/** Equivalent of adminDb.collection(coll).doc(id).set(data) (full overwrite) or .set(data,{merge:true}) */
export async function fsSet(env: Env, collection: string, id: string, data: Record<string, FirestoreValue>, opts: { merge?: boolean } = {}): Promise<void> {
  const url = new URL(`${docBaseUrl(env)}/${collection}/${encodeURIComponent(id)}`);
  if (opts.merge) {
    for (const key of Object.keys(data)) url.searchParams.append("updateMask.fieldPaths", key);
  }
  const res = await firestoreFetch(env, url.toString(), {
    method: "PATCH",
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore set(${collection}/${id}) failed: ${res.status} ${await res.text()}`);
}

/** Equivalent of adminDb.collection(coll).doc(id).update(data) — merges only the given top-level fields */
export async function fsUpdate(env: Env, collection: string, id: string, data: Record<string, FirestoreValue>): Promise<void> {
  return fsSet(env, collection, id, data, { merge: true });
}

/** Equivalent of adminDb.collection(coll).add(data) — auto-generated id */
export async function fsAdd(env: Env, collection: string, data: Record<string, FirestoreValue>): Promise<{ id: string }> {
  const res = await firestoreFetch(env, `${docBaseUrl(env)}/${collection}`, {
    method: "POST",
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore add(${collection}) failed: ${res.status} ${await res.text()}`);
  const doc = (await res.json()) as { name: string };
  return { id: doc.name.substring(doc.name.lastIndexOf("/") + 1) };
}

/**
 * Server timestamp: `admin.firestore.FieldValue.serverTimestamp()` is a
 * write-time sentinel resolved by Firestore itself via a field-transform
 * write. Every use of it in this project is a single, immediately-committed
 * server write (never an offline/queued client write), so a timestamp
 * captured here at request time is behaviorally equivalent — same accuracy
 * a Netlify Function's Node clock would have given you anyway.
 */
export function serverTimestamp(): Date {
  return new Date();
}

// ══════════════════════════════════════════════════════════════════════════
// Identity Toolkit v1 REST — user creation/update, ID-token verification,
// and custom-token minting (replaces admin.auth())
// ══════════════════════════════════════════════════════════════════════════

export class AuthError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

async function identityFetch(env: Env, path: string, body: unknown): Promise<any> {
  const token = await getAccessToken(env, [SCOPE_IDENTITY]);
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json?.error?.message || `Identity Toolkit request failed (${res.status})`;
    throw new AuthError(message, json?.error?.status);
  }
  return json;
}

/** Equivalent of adminAuth.createUser({ email, password, displayName }) */
export async function authCreateUser(env: Env, input: { email: string; password: string; displayName?: string }): Promise<{ uid: string }> {
  try {
    const result = await identityFetch(env, "accounts:signUp", {
      email: input.email,
      password: input.password,
      displayName: input.displayName,
      returnSecureToken: false,
    });
    return { uid: result.localId };
  } catch (err: any) {
    // Surface the same style of message the Admin SDK gives for the common
    // case (e.g. "EMAIL_EXISTS" -> "auth/email-already-exists"-ish text) so
    // the existing route code's `err.message` passthrough still reads well.
    if (err?.message?.includes("EMAIL_EXISTS")) throw new AuthError("The email address is already in use by another account.");
    throw err;
  }
}

/** Equivalent of adminAuth.updateUser(uid, { password }) and/or { disabled }) */
export async function authUpdateUser(env: Env, uid: string, updates: { password?: string; disabled?: boolean }): Promise<void> {
  await identityFetch(env, "accounts:update", {
    localId: uid,
    password: updates.password,
    disableUser: updates.disabled,
  });
}

/**
 * Equivalent of adminAuth.createCustomToken(uid, claims) — minted locally
 * with the service account's private key; Firebase never sees this request,
 * exactly like the Admin SDK version (the client later exchanges it for a
 * real session via signInWithCustomToken, unchanged).
 */
export async function authCreateCustomToken(env: Env, uid: string, claims: Record<string, unknown> = {}): Promise<string> {
  const sa = getServiceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  return signJwtRS256(
    { alg: "RS256", typ: "JWT" },
    {
      iss: sa.client_email,
      sub: sa.client_email,
      aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
      iat: now,
      exp: now + 3600,
      uid,
      claims,
    },
    sa
  );
}

// ── ID token verification (replaces adminAuth.verifyIdToken) ────────────────
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let jwksCache: { keys: Record<string, JsonWebKey>; expiresAt: number } | null = null;

async function getGoogleJwks(): Promise<Record<string, JsonWebKey>> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`Failed to fetch Google JWKS: ${res.status}`);
  const data = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  const keys: Record<string, JsonWebKey> = {};
  for (const k of data.keys) keys[k.kid!] = k;
  // Cache for an hour; Google rotates these infrequently and sends
  // Cache-Control max-age itself, but a flat hour keeps this simple.
  jwksCache = { keys, expiresAt: Date.now() + 60 * 60_000 };
  return keys;
}

export interface DecodedIdToken {
  uid: string;
  [claim: string]: unknown;
}

/**
 * Equivalent of adminAuth.verifyIdToken(idToken). Verifies the RS256
 * signature against Google's published public keys and checks iss/aud/exp,
 * per Firebase's documented "manually verify" procedure.
 */
export async function authVerifyIdToken(env: Env, idToken: string): Promise<DecodedIdToken> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new AuthError("Malformed ID token.");
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(new TextDecoder().decode(bytesFromBase64Url(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(bytesFromBase64Url(payloadB64)));

  const sa = getServiceAccount(env);
  const now = Math.floor(Date.now() / 1000);

  if (payload.iss !== `https://securetoken.google.com/${sa.project_id}`) throw new AuthError("Invalid token issuer.");
  if (payload.aud !== sa.project_id) throw new AuthError("Invalid token audience.");
  if (typeof payload.exp !== "number" || payload.exp < now) throw new AuthError("Token expired.");
  if (typeof payload.iat !== "number" || payload.iat > now + 60) throw new AuthError("Token issued in the future.");
  if (!payload.sub || typeof payload.sub !== "string") throw new AuthError("Token missing subject.");

  const jwks = await getGoogleJwks();
  const jwk = jwks[header.kid];
  if (!jwk) throw new AuthError("Unknown signing key.");

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    bytesFromBase64Url(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new AuthError("Invalid token signature.");

  return { ...payload, uid: payload.sub };
}

// ══════════════════════════════════════════════════════════════════════════
// FCM v1 REST — replaces admin.messaging().sendEachForMulticast()
// ══════════════════════════════════════════════════════════════════════════

export interface FcmSendInput {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  webpushLink?: string;
  webpushIcon?: string;
}

export interface FcmSendResult {
  success: boolean;
  /** Set when the token is permanently invalid (uninstalled/expired) and should be pruned. */
  isInvalidToken: boolean;
  error?: string;
}

/**
 * The Admin SDK's sendEachForMulticast() sends one request per token under
 * the hood (FCM v1 has no true batch/multicast endpoint) — this mirrors
 * that by sending one messages:send call per token; callers already loop
 * over tokens for cleanup purposes so this preserves that behavior.
 */
export async function fcmSend(env: Env, input: FcmSendInput): Promise<FcmSendResult> {
  const sa = getServiceAccount(env);
  const token = await getAccessToken(env, [SCOPE_FCM]);

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token: input.token,
        notification: { title: input.title, body: input.body },
        data: input.data || {},
        webpush: {
          fcm_options: input.webpushLink ? { link: input.webpushLink } : undefined,
          notification: input.webpushIcon ? { icon: input.webpushIcon } : undefined,
        },
      },
    }),
  });

  if (res.ok) return { success: true, isInvalidToken: false };

  const json = await res.json().catch(() => ({}));
  const errorCode: string | undefined = json?.error?.details?.find(
    (d: any) => d["@type"]?.includes("FcmError")
  )?.errorCode;
  const isInvalidToken = errorCode === "UNREGISTERED" || errorCode === "INVALID_ARGUMENT";
  return { success: false, isInvalidToken, error: json?.error?.message || `FCM send failed (${res.status})` };
}
