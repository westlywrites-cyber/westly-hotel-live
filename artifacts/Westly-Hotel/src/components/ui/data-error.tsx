import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shared "failed to load" state for any view backed by useCollection /
 * useDocument. Firestore's onSnapshot already auto-recovers from transient
 * network drops, but permission-denied errors and persistent outages don't
 * self-heal — without this, those cases silently render as an empty list,
 * which looks identical to "there's just no data" and hides real problems
 * from both guests and staff.
 */
export function DataError({
  message,
  detail,
  onRetry,
  className = "",
}: {
  message?: string | null;
  /**
   * The raw Firestore error (e.g. `.code` like "permission-denied" or
   * "failed-precondition", or `.message`). Optional — shown as a small
   * monospace line so a screenshot from a phone (no devtools access) is
   * enough to diagnose whether a failure is a security-rules denial, a
   * missing composite index, or something else, instead of everyone having
   * to guess from a generic "couldn't load" message alone.
   */
  detail?: string | null;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 text-center py-12 px-4 ${className}`}
      role="alert"
    >
      <AlertTriangle className="w-8 h-8 text-destructive/70" />
      <p className="font-medium text-sm">Couldn't load this data</p>
      <p className="text-muted-foreground text-xs max-w-sm">
        {message || "Something went wrong while fetching this. Check your connection and try again."}
      </p>
      {detail && (
        <p className="text-muted-foreground/70 text-[10px] font-mono max-w-sm break-words">
          {detail}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-1"
        onClick={onRetry || (() => window.location.reload())}
      >
        <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
        Retry
      </Button>
    </div>
  );
}
