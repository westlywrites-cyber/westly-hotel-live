import type { Env } from "../_shared/firebaseRest";
import { requireActiveUser, jsonResponse, HttpError } from "../_shared/admin";
import { getSupabaseServiceClient, type SupabaseEnv } from "../_shared/supabaseAdmin";
import { hasPermission, type Role } from "../../src/lib/rbac";

type ReplyStatus = "none" | "pending" | "replied";

interface MessagesUpdateBody {
  id?: string;
  action?: "mark_read" | "set_reply_status" | "soft_delete";
  replyStatus?: ReplyStatus;
}

// Covers the three admin mutation operations that used to run directly
// against Supabase with the public anon key (audit finding C-3):
// markMessageRead, setReplyStatus, softDeleteMessage. Field names and value
// semantics (status, read_at, reply_status, replied_at, is_deleted) are
// preserved exactly from the prior client-side code in src/lib/messages.ts.
export const onRequestPost: PagesFunction<Env & SupabaseEnv> = async (context) => {
  const { request, env } = context;
  try {
    const caller = await requireActiveUser(env, request.headers.get("authorization"));
    if (!hasPermission(caller.role as Role, "view:messages")) {
      throw new HttpError(403, "You don't have permission to update the Message Inbox.");
    }

    const body = await request.json<MessagesUpdateBody>();
    if (!body.id) throw new HttpError(400, "id is required.");
    if (!body.action) throw new HttpError(400, "action is required.");

    const supabase = getSupabaseServiceClient(env);
    if (!supabase) {
      return jsonResponse(500, { error: "Message service is not configured." });
    }

    let update: Record<string, unknown>;
    switch (body.action) {
      case "mark_read":
        update = { status: "read", read_at: new Date().toISOString() };
        break;
      case "set_reply_status": {
        if (!body.replyStatus || !["none", "pending", "replied"].includes(body.replyStatus)) {
          throw new HttpError(400, "A valid replyStatus is required for set_reply_status.");
        }
        update = {
          reply_status: body.replyStatus,
          replied_at: body.replyStatus === "replied" ? new Date().toISOString() : null,
        };
        break;
      }
      case "soft_delete":
        update = { is_deleted: true };
        break;
      default:
        throw new HttpError(400, "Unknown action.");
    }

    const { error } = await supabase.from("messages").update(update).eq("id", body.id);
    if (error) {
      return jsonResponse(500, { error: "Couldn't update the message." });
    }

    return jsonResponse(200, { success: true });
  } catch (err: any) {
    if (err instanceof HttpError) return jsonResponse(err.statusCode, { error: err.message });
    return jsonResponse(500, { error: "Couldn't update the message." });
  }
};
