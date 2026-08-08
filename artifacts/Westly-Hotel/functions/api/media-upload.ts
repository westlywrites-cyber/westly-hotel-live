import type { Env } from "../_shared/firebaseRest";
import { requireActiveUser, jsonResponse, HttpError } from "../_shared/admin";
import { getSupabaseServiceClient, type SupabaseEnv } from "../_shared/supabaseAdmin";

const BUCKET = "westly-media";
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB — matches supabase/storage.sql's bucket file_size_limit
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

// Server-side allow-list of upload folders. Kept in sync with the real,
// current ImageFolder union in src/lib/storage.ts (the client already
// enforces this at the type level) rather than the shorter 9-folder list
// in this phase prompt's prose and in supabase/storage.sql's header
// comment, both of which have gone stale relative to the actual feature
// set (gym, bar-menu, and several cms-*-hero folders were added since).
// Restricting to the prompt's stale list would break real, working upload
// surfaces the app depends on today (§1.2/§3.1 of the execution
// instructions: work from the real, current code; preserve existing
// functionality). The point of this allow-list is unchanged either way —
// a compromised/malicious client must not be able to write to an arbitrary
// storage path — it just needs to match reality.
const ALLOWED_FOLDERS = [
  "rooms",
  "facilities",
  "lost-found",
  "restaurant-menu",
  "bar-menu",
  "cms-hero",
  "cms-about",
  "gallery",
  "venues",
  "gym",
  "cms-contact-hero",
  "cms-faq-hero",
  "cms-facilities-hero",
  "cms-rooms-hero",
  "cms-restaurant-hero",
  "cms-testimonials-hero",
  "cms-venue-hero",
  "cms-gym-hero",
  "cms-login-background",
];

interface MediaUploadBody {
  folder?: string;
  fileName?: string;
  contentType?: string;
  /** Base64-encoded file bytes (no data: URL prefix). */
  base64?: string;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomId(): string {
  return crypto.randomUUID();
}

function extensionFor(fileName: string, contentType: string): string {
  const fromName = fileName.split(".").pop();
  if (fromName && fromName.length <= 5) return fromName.toLowerCase();
  return (contentType.split("/")[1] || "jpg").toLowerCase();
}

// Requires only an active, server-verified staff session — no additional
// role restriction. Per-page route guards already gate who can reach the
// upload UI; this fix's job is only to replace the bare anon key with a
// real session check (audit finding C-3), matching supabase/storage.sql's
// documented intent.
export const onRequestPost: PagesFunction<Env & SupabaseEnv> = async (context) => {
  const { request, env } = context;
  try {
    await requireActiveUser(env, request.headers.get("authorization"));

    const body = await request.json<MediaUploadBody>();
    const { folder, fileName, contentType, base64 } = body;

    if (!folder || !ALLOWED_FOLDERS.includes(folder)) {
      throw new HttpError(400, "Invalid upload folder.");
    }
    if (!contentType || !ALLOWED_TYPES.includes(contentType)) {
      throw new HttpError(400, "Please choose a JPEG, PNG, WEBP, GIF, or AVIF image.");
    }
    if (!base64) {
      throw new HttpError(400, "No file data provided.");
    }

    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(base64);
    } catch {
      throw new HttpError(400, "Couldn't read the uploaded file.");
    }

    if (bytes.byteLength > MAX_FILE_SIZE) {
      throw new HttpError(400, "That image is larger than 8MB. Please choose a smaller file.");
    }

    const supabase = getSupabaseServiceClient(env);
    if (!supabase) {
      return jsonResponse(500, { error: "Media upload service is not configured." });
    }

    // Collision-resistant filename (UUID), matching the scheme
    // src/lib/storage.ts already used client-side — two simultaneous
    // uploads can never silently overwrite each other under the same
    // generated path.
    const path = `${folder}/${randomId()}.${extensionFor(fileName || "", contentType)}`;

    const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
      cacheControl: "31536000",
      upsert: false,
      contentType,
    });
    if (error) {
      return jsonResponse(500, { error: "Upload failed. Please try again." });
    }

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return jsonResponse(200, { url: data.publicUrl });
  } catch (err: any) {
    if (err instanceof HttpError) return jsonResponse(err.statusCode, { error: err.message });
    return jsonResponse(500, { error: "Upload failed. Please try again." });
  }
};
