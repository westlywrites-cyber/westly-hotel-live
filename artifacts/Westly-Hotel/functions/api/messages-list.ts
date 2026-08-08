import type { Env } from "../_shared/firebaseRest";
import { requireActiveUser, jsonResponse, HttpError } from "../_shared/admin";
import { getSupabaseServiceClient, type SupabaseEnv } from "../_shared/supabaseAdmin";
import { hasPermission, type Role } from "../../src/lib/rbac";

// Admin-facing read of the Message Inbox (audit finding C-3): this used to
// go straight from the client to Supabase using the public anon key, which
// — per schema.sql's own RLS policies — granted select on `messages` to
// anyone holding that key, not only signed-in staff. This endpoint moves
// the read behind a server-verified Firebase session and a Supabase
// service-role key that never reaches the client.
export const onRequestPost: PagesFunction<Env & SupabaseEnv> = async (context) => {
  const { request, env } = context;
  try {
    const caller = await requireActiveUser(env, request.headers.get("authorization"));
    if (!hasPermission(caller.role as Role, "view:messages")) {
      throw new HttpError(403, "You don't have permission to view the Message Inbox.");
    }

    const supabase = getSupabaseServiceClient(env);
    if (!supabase) {
      return jsonResponse(500, { error: "Message service is not configured." });
    }

    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("is_deleted", false)
      .order("created_at", { ascending: false });

    if (error) {
      // Generic, non-leaking error — never surface Supabase's internal
      // table/column/constraint details to the client.
      return jsonResponse(500, { error: "Couldn't load messages." });
    }

    return jsonResponse(200, { messages: data ?? [] });
  } catch (err: any) {
    if (err instanceof HttpError) return jsonResponse(err.statusCode, { error: err.message });
    return jsonResponse(500, { error: "Couldn't load messages." });
  }
};
