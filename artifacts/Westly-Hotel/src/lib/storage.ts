import { supabase, isSupabaseConfigured } from "./supabase";
import { logUploadError } from "./diagnostics";
import { callAdminFunction } from "./adminApi";

// ══════════════════════════════════════════════════════════════════════════
// IMAGE UPLOADS — Supabase Storage, used ONLY by the features that used to
// require a pasted image URL:
//   Hotel rooms, Hotel facilities, Lost & Found, Restaurant menu,
//   CMS Hero section, CMS About section, Gallery page, and several other
//   folders added since (see ImageFolder below — this is the current,
//   authoritative list).
//
// Every uploaded file goes into the single public "westly-media" bucket
// (see supabase/storage.sql), under a folder named after the feature, and
// this returns the public URL — which is then stored in the exact same
// Firestore field that used to hold a manually-pasted URL (e.g. `image`,
// `images[]`, `photoUrl`, `imageUrl`, `backgroundImage`). Nothing about the
// Firestore data model changes; only how that URL gets there.
//
// UPLOAD/DELETE PATH goes through the Cloudflare Functions /api/media-upload
// and /api/media-delete instead of writing to Supabase Storage directly
// with the public anon key (audit finding C-3) — a Firebase-authenticated
// staff session is required server-side, and the folder is validated
// against a fixed allow-list there too. The public read path (rendering an
// already-uploaded image's public URL on the guest-facing site) is
// UNCHANGED — that bucket stays public-read, as intended.
// ══════════════════════════════════════════════════════════════════════════

export type ImageFolder =
  | "rooms"
  | "facilities"
  | "lost-found"
  | "restaurant-menu"
  | "bar-menu"
  | "cms-hero"
  | "cms-about"
  | "gallery"
  | "venues"
  | "gym"
  | "cms-contact-hero"
  | "cms-faq-hero"
  | "cms-facilities-hero"
  | "cms-rooms-hero"
  | "cms-restaurant-hero"
  | "cms-testimonials-hero"
  | "cms-venue-hero"
  | "cms-gym-hero"
  | "cms-login-background";

const BUCKET = "westly-media";

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB, matches the bucket's file_size_limit
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

export class ImageUploadError extends Error {}

/** Reads a File into a base64 string (no `data:...;base64,` prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the selected file."));
    reader.readAsDataURL(file);
  });
}

/**
 * Uploads an image file via the server-side /api/media-upload function and
 * returns its public URL. Throws ImageUploadError with a user-friendly
 * message on any failure — callers should catch this and show it via toast
 * rather than letting it propagate as an unhandled rejection.
 */
export async function uploadImage(file: File, folder: ImageFolder): Promise<string> {
  if (!isSupabaseConfigured || !supabase) {
    logUploadError("image_upload", new Error("Supabase Storage is not configured"), folder);
    throw new ImageUploadError(
      "Image uploads aren't connected yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
    );
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new ImageUploadError("Please choose a JPEG, PNG, WEBP, GIF, or AVIF image.");
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new ImageUploadError("That image is larger than 8MB. Please choose a smaller file.");
  }

  try {
    const base64 = await fileToBase64(file);
    const { url } = await callAdminFunction<{ url: string }>("media-upload", {
      folder,
      fileName: file.name,
      contentType: file.type,
      base64,
    });
    return url;
  } catch (error: any) {
    // Only genuine upload failures are logged here — the validation checks
    // above (wrong type, too large) are expected user input, not bugs.
    logUploadError("image_upload", error, folder);
    throw new ImageUploadError(error?.message || "Upload failed. Please try again.");
  }
}

/**
 * Best-effort delete of a previously-uploaded image, given its public URL,
 * via the server-side /api/media-delete function.
 * Safe to call on URLs that were never in our bucket (e.g. legacy pasted
 * URLs from before this feature existed) — those are simply skipped.
 */
export async function deleteImageByUrl(url: string | null | undefined): Promise<void> {
  if (!url || !isSupabaseConfigured || !supabase) return;
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  if (url.indexOf(marker) === -1) return; // not one of our uploaded files — nothing to clean up
  await callAdminFunction<{ success: true }>("media-delete", { url }).catch(() => {});
}
