import type { Env } from "../_shared/firebaseRest";
import { jsonResponse, HttpError, requireHousekeepingSupervisor } from "../_shared/admin";
import { runHousekeepingQueueGeneration } from "../_shared/housekeepingQueue";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  try {
    await requireHousekeepingSupervisor(env, request.headers.get("authorization"));
    const result = await runHousekeepingQueueGeneration(env);
    return jsonResponse(200, result);
  } catch (err: any) {
    if (err instanceof HttpError) return jsonResponse(err.statusCode, { error: err.message });
    return jsonResponse(500, { error: err?.message || "Failed to run the housekeeping queue generator." });
  }
};
