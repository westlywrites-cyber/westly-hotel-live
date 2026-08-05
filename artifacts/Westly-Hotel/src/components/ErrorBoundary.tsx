import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { logRenderError } from "@/lib/diagnostics";
import { useAuth } from "@/contexts/AuthContext";

interface ClassProps {
  children: ReactNode;
  /** Optional label shown in the error message, e.g. "Facilities Management" */
  label?: string;
  /** Only Super Admins get the technical error detail — everyone else gets a plain, friendly message. */
  isSuperAdmin: boolean;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors in its subtree.
 *
 * Without this, an uncaught error anywhere in the tree unmounts the ENTIRE
 * React app and leaves a blank white screen with no on-screen indication of
 * what happened — the exact failure mode this project had no protection
 * against. This boundary confines the damage to the page that crashed,
 * reports it to the Diagnostics system so a Super Admin can see it in the
 * dashboard, and shows a recoverable, professional message — with the raw
 * error only ever surfaced to Super Admins, never to normal users or other
 * staff roles.
 */
class ErrorBoundaryClass extends Component<ClassProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Caught render error:", error, info.componentStack);
    logRenderError(error, info.componentStack, this.props.label).catch(() => {});
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-[60vh] flex items-center justify-center p-6">
          <div className="max-w-md text-center space-y-4">
            <div className="w-16 h-16 bg-destructive/10 rounded-full flex items-center justify-center mx-auto">
              <AlertTriangle className="w-8 h-8 text-destructive" />
            </div>
            <div>
              <h2 className="text-xl font-semibold">
                {this.props.label ? `${this.props.label} ran into a problem` : "Something went wrong"}
              </h2>
              <p className="text-muted-foreground text-sm mt-1">
                {this.props.isSuperAdmin
                  ? "This section crashed while loading. Your data is safe — this is just a display error. Full details have been logged to the Diagnostics dashboard."
                  : "Something went wrong. Please try again. If the problem persists, contact your administrator."}
              </p>
            </div>
            {this.props.isSuperAdmin && (
              <pre className="text-left text-xs bg-muted rounded-lg p-3 overflow-auto max-h-40 text-muted-foreground">
                {this.state.error.message}
              </pre>
            )}
            <Button onClick={() => this.setState({ error: null })} className="gap-2">
              <RefreshCw className="w-4 h-4" /> Try Again
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Public wrapper — keeps the exact same API (`children`, `label`) every
 * existing call site already uses, while resolving the current user's role
 * from AuthContext so the class component above can decide how much detail
 * to show. `useAuth()` is safe to call anywhere in the tree since
 * AuthProvider wraps the whole app in src/App.tsx.
 */
export function ErrorBoundary({ children, label }: { children: ReactNode; label?: string }) {
  const { role } = useAuth();
  return (
    <ErrorBoundaryClass label={label} isSuperAdmin={role === "super_admin"}>
      {children}
    </ErrorBoundaryClass>
  );
}
