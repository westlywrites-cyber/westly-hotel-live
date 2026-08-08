import type { Env } from "../_shared/firebaseRest";
import { requireActiveUser, jsonResponse, HttpError } from "../_shared/admin";
import { getSupabaseServiceClient, type SupabaseEnv } from "../_shared/supabaseAdmin";

const BUCKET = "westly-media";

interface MediaDeleteBody {
  /** The full public URL previously returned by media-upload, same as the client already stores. */
  url?: string;
}

// Same authorization model as media-upload.ts — any active, server-verified
// staff session (audit finding C-3). Best-effort by design, matching
// deleteImageByUrl()'s prior client-side semantics: a URL that isn't one of
// ours (e.g. a legacy pasted URL from before this feature existed) is
// simply skipped rather than treated as an error.
export const onRequestPost: PagesFunction<Env & SupabaseEnv> = async (context) => {
  const { request, env } = context;
  try {
    await requireActiveUser(env, request.headers.get("authorization"));

    const body = await request.json<MediaDeleteBody>();
    const url = body.url;
    if (!url) return jsonResponse(200, { success: true, skipped: true });

    const marker = `/storage/v1/object/public/${BUCKET}/`;
    const idx = url.indexOf(marker);
    if (idx === -1) return jsonResponse(200, { success: true, skipped: true });
    const path = url.slice(idx + marker.length);
    if (!path) return jsonResponse(200, { success: true, skipped: true });

    const supabase = getSupabaseServiceClient(env);
    if (!supabase) {
      return jsonResponse(500, { error: "Media delete service is not configured." });
    }

    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) {
      return jsonResponse(500, { error: "Delete failed." });
    }

    return jsonResponse(200, { success: true });
  } catch (err: any) {
    if (err instanceof HttpError) return jsonResponse(err.statusCode, { error: err.message });
    return jsonResponse(500, { error: "Delete failed." });
  }
};
