import { useCallback, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { withTimeout } from "@/lib/utils";
import { captureError, startOperation, endOperation, type ErrorCategory } from "@/lib/diagnostics";

// ══════════════════════════════════════════════════════════════════════════
// useAsyncAction — the standard way to wire a button/form to an async
// operation (save, submit, check-in, upload, approve, delete, …).
//
// Fixes, by construction, every symptom in the "stuck on Processing…" bug
// class:
//   • Loading state ALWAYS starts on call and ALWAYS clears in `finally` —
//     there is no code path that can leave `isLoading` stuck true.
//   • The underlying promise is raced against a timeout (withTimeout), so a
//     hung request (dropped connection, a promise that never settles)
//     surfaces a clear error instead of spinning forever.
//   • A parallel diagnostics watchdog (startOperation/endOperation) reports
//     to the Diagnostics Dashboard if the operation is still "in flight"
//     past its timeout — even if the component has since unmounted.
//   • Duplicate submissions while an operation is in flight are ignored
//     (the button click is a no-op, not a queued second request).
//   • Success/error toasts are opt-in and consistent in wording.
//
// USAGE
//   const { run, isLoading } = useAsyncAction(
//     async (id: string) => { await updateDoc(doc(db, "bookings", id), {...}); },
//     { successTitle: "Saved", successMessage: "Booking updated successfully.",
//       errorTitle: "Save Failed", category: "firestore_query", source: "BookingsPage" }
//   );
//   <Button disabled={isLoading} onClick={() => run(booking.id)}>
//     {isLoading ? "Saving…" : "Save"}
//   </Button>
// ══════════════════════════════════════════════════════════════════════════

export interface UseAsyncActionOptions<R> {
  /** Max time (ms) to wait before treating the operation as hung. Default 20000. */
  timeoutMs?: number;
  /** Message shown to the user if the timeout is hit. */
  timeoutMessage?: string;
  /** Toast title on success. Omit (with successMessage) to skip the success toast entirely. */
  successTitle?: string;
  successMessage?: string | ((result: R) => string);
  /** Toast title on failure. Defaults to "Something Went Wrong". Failure toasts always show. */
  errorTitle?: string;
  /** Diagnostics category for failures. Defaults to "other". */
  category?: ErrorCategory;
  /** File/page/component name, recorded on the diagnostic log. */
  source?: string;
  /** Human label for this operation, recorded on the diagnostic log and used as the watchdog name. */
  action?: string;
  onSuccess?: (result: R) => void;
  onError?: (error: unknown) => void;
}

export function useAsyncAction<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  options: UseAsyncActionOptions<R> = {}
) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const inFlight = useRef(false);

  const run = useCallback(
    async (...args: Args): Promise<R | undefined> => {
      if (inFlight.current) return undefined; // duplicate-submit guard
      inFlight.current = true;
      setIsLoading(true);

      const timeoutMs = options.timeoutMs ?? 20_000;
      const label = options.action || "async operation";
      const watchdogToken = startOperation(label, options.source, timeoutMs);

      try {
        const result = await withTimeout(fn(...args), timeoutMs, options.timeoutMessage);
        if (options.successTitle || options.successMessage) {
          toast({
            title: options.successTitle ?? "Success",
            description:
              typeof options.successMessage === "function" ? options.successMessage(result) : options.successMessage,
          });
        }
        options.onSuccess?.(result);
        return result;
      } catch (err: any) {
        toast({
          title: options.errorTitle ?? "Something Went Wrong",
          description: err?.message || "Please try again.",
          variant: "destructive",
        });
        captureError({
          message: err?.message || String(err),
          category: options.category ?? "other",
          severity: "error",
          source: options.source,
          action: options.action,
          stack: err?.stack,
        });
        options.onError?.(err);
        return undefined;
      } finally {
        endOperation(watchdogToken);
        inFlight.current = false;
        setIsLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fn]
  );

  return { run, isLoading };
}
