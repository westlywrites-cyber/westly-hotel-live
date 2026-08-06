import { useState, useMemo } from "react";
import { doc, updateDoc, orderBy, limit } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCollection } from "@/hooks/useFirebase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Activity, AlertTriangle, AlertCircle, Info, XCircle, CheckCircle2,
  Search, Download, ChevronDown, ChevronUp, Wifi, WifiOff,
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from "recharts";
import { formatDateTime, toFirestoreDate } from "@/lib/utils";
import { DataError } from "@/components/ui/data-error";
import { useToast } from "@/hooks/use-toast";
import type { ErrorSeverity } from "@/lib/diagnostics";

interface DiagnosticLog {
  id: string;
  message: string;
  category: string;
  severity: ErrorSeverity;
  source?: string | null;
  action?: string | null;
  stack?: string | null;
  rootCause?: string | null;
  suggestion?: string | null;
  route?: string | null;
  userId?: string | null;
  userName?: string | null;
  userRole?: string | null;
  browser?: { userAgent?: string; language?: string; online?: boolean; viewport?: string } | null;
  resolved?: boolean;
  timestamp?: unknown;
}

const SEVERITY_META: Record<ErrorSeverity, { label: string; color: string; icon: typeof Info }> = {
  info: { label: "Info", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400", icon: Info },
  warning: { label: "Warning", color: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400", icon: AlertTriangle },
  error: { label: "Error", color: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400", icon: AlertCircle },
  critical: { label: "Critical", color: "bg-red-200 text-red-900 dark:bg-red-950 dark:text-red-300 font-semibold", icon: XCircle },
};

const CATEGORY_LABELS: Record<string, string> = {
  render: "Render",
  javascript: "JavaScript",
  api: "API Request",
  firebase_auth: "Auth / Authorization",
  firestore_permission: "Firestore Permission",
  firestore_query: "Database Query",
  realtime_sync: "Realtime Sync",
  supabase: "Supabase",
  image_upload: "Image Upload",
  file_upload: "File Upload",
  network: "Network",
  routing: "Routing",
  performance: "Performance",
  background_job: "Background Job",
  other: "Other",
};

const HOUR_MS = 60 * 60 * 1000;

export default function DiagnosticsPage() {
  const { toast } = useToast();
  // Recent window only — the dashboard is for active troubleshooting, not a
  // full historical archive, and keeping this bounded avoids ever pulling
  // an unbounded number of documents into the browser.
  const { data: logs, loading, error, refetch } = useCollection<DiagnosticLog>(
    "diagnostic_logs",
    [orderBy("timestamp", "desc"), limit(500)]
  );

  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const now = Date.now();
  const last24h = useMemo(
    () => logs.filter((l) => (toFirestoreDate(l.timestamp)?.getTime() ?? 0) > now - 24 * HOUR_MS),
    [logs, now]
  );
  const last15min = useMemo(
    () => logs.filter((l) => (toFirestoreDate(l.timestamp)?.getTime() ?? 0) > now - 15 * 60 * 1000),
    [logs, now]
  );

  const stats = useMemo(() => {
    const critical = last24h.filter((l) => l.severity === "critical").length;
    const errors = last24h.filter((l) => l.severity === "error").length;
    const warnings = last24h.filter((l) => l.severity === "warning").length;
    const unresolved = logs.filter((l) => !l.resolved && (l.severity === "error" || l.severity === "critical")).length;
    return { total: last24h.length, critical, errors, warnings, unresolved };
  }, [last24h, logs]);

  // System health: any critical error in the last 15 minutes is "Critical";
  // 3+ unresolved errors is "Degraded"; otherwise "Healthy". Simple and
  // legible at a glance rather than a black-box score.
  const health = useMemo(() => {
    const recentCritical = last15min.some((l) => l.severity === "critical");
    if (recentCritical) return { label: "Critical", color: "text-red-600 bg-red-100 dark:bg-red-900/30 dark:text-red-400", icon: XCircle };
    if (stats.unresolved >= 3) return { label: "Degraded", color: "text-amber-600 bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400", icon: AlertTriangle };
    return { label: "Healthy", color: "text-green-600 bg-green-100 dark:bg-green-900/30 dark:text-green-400", icon: CheckCircle2 };
  }, [last15min, stats.unresolved]);

  const categoryChartData = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of last24h) counts.set(l.category, (counts.get(l.category) ?? 0) + 1);
    return Array.from(counts.entries())
      .map(([category, count]) => ({ category: CATEGORY_LABELS[category] || category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [last24h]);

  const categories = useMemo(() => {
    const cats = new Set(logs.map((l) => l.category).filter(Boolean));
    return ["all", ...Array.from(cats)];
  }, [logs]);

  const filtered = useMemo(() => {
    return logs.filter((log) => {
      const matchSearch =
        !search ||
        log.message?.toLowerCase().includes(search.toLowerCase()) ||
        log.source?.toLowerCase().includes(search.toLowerCase()) ||
        log.userName?.toLowerCase().includes(search.toLowerCase());
      const matchSeverity = severityFilter === "all" || log.severity === severityFilter;
      const matchCategory = categoryFilter === "all" || log.category === categoryFilter;
      const matchStatus =
        statusFilter === "all" ||
        (statusFilter === "unresolved" && !log.resolved) ||
        (statusFilter === "resolved" && log.resolved);
      return matchSearch && matchSeverity && matchCategory && matchStatus;
    });
  }, [logs, search, severityFilter, categoryFilter, statusFilter]);

  const toggleResolved = async (log: DiagnosticLog) => {
    try {
      await updateDoc(doc(db, "diagnostic_logs", log.id), { resolved: !log.resolved });
    } catch {
      toast({ title: "Error", description: "Couldn't update that log entry.", variant: "destructive" });
    }
  };

  const exportCSV = () => {
    const csv = [
      ["Timestamp", "Severity", "Category", "Message", "Source", "Root Cause", "User", "Role", "Route", "Resolved"],
      ...filtered.map((log) => [
        formatDateTime(toFirestoreDate(log.timestamp)),
        log.severity,
        CATEGORY_LABELS[log.category] || log.category,
        log.message,
        log.source || "",
        log.rootCause || "",
        log.userName || "",
        log.userRole || "",
        log.route || "",
        log.resolved ? "Yes" : "No",
      ]),
    ]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `diagnostics-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const HealthIcon = health.icon;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif text-2xl font-bold flex items-center gap-2">
            <Activity className="w-6 h-6 text-primary" /> Diagnostics
          </h1>
          <p className="text-muted-foreground text-sm">Application error monitoring — visible only to Super Admins</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 ${health.color}`}>
            <HealthIcon className="w-3.5 h-3.5" /> {health.label}
          </span>
          <Button variant="outline" size="sm" className="gap-2" onClick={exportCSV}>
            <Download className="w-4 h-4" /> Export CSV
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Events (24h)</p>
            <p className="text-2xl font-bold mt-1">{stats.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Critical (24h)</p>
            <p className="text-2xl font-bold mt-1 text-red-600">{stats.critical}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Errors (24h)</p>
            <p className="text-2xl font-bold mt-1 text-orange-600">{stats.errors}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Unresolved</p>
            <p className="text-2xl font-bold mt-1 text-amber-600">{stats.unresolved}</p>
          </CardContent>
        </Card>
      </div>

      {/* Category breakdown chart */}
      {categoryChartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Errors by Category (last 24h)</CardTitle>
          </CardHeader>
          <CardContent className="h-52 pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={categoryChartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" allowDecimals={false} fontSize={12} />
                <YAxis type="category" dataKey="category" width={130} fontSize={12} />
                <Tooltip />
                <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search message, source, user…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10" />
        </div>
        <Select value={severityFilter} onValueChange={setSeverityFilter}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Severity" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Severities</SelectItem>
            {(Object.keys(SEVERITY_META) as ErrorSeverity[]).map((s) => (
              <SelectItem key={s} value={s}>{SEVERITY_META[s].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>{c === "all" ? "All Categories" : CATEGORY_LABELS[c] || c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="unresolved">Unresolved</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Log table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : error ? (
            <DataError message="We couldn't load the diagnostics log." onRetry={refetch} />
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <CheckCircle2 className="w-10 h-10 mx-auto mb-2 opacity-30" />
              <p>No matching events — the app is quiet.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filtered.slice(0, 200).map((log) => {
                const meta = SEVERITY_META[log.severity] || SEVERITY_META.error;
                const SeverityIcon = meta.icon;
                const isOpen = expanded.has(log.id);
                return (
                  <div key={log.id} className="text-sm">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(log.id)}
                      className="w-full flex items-start gap-3 py-3 px-4 text-left hover:bg-muted/20"
                    >
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium flex items-center gap-1 shrink-0 mt-0.5 ${meta.color}`}>
                        <SeverityIcon className="w-3 h-3" /> {meta.label}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{log.message}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {CATEGORY_LABELS[log.category] || log.category}
                          {log.source ? ` · ${log.source}` : ""}
                          {log.userRole ? ` · ${log.userRole.replace("_", " ")}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {log.resolved && <Badge variant="outline" className="text-[10px]">Resolved</Badge>}
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDateTime(toFirestoreDate(log.timestamp))}
                        </span>
                        {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                      </div>
                    </button>
                    {isOpen && (
                      <div className="px-4 pb-4 pl-[4.5rem] space-y-2 text-xs">
                        {log.rootCause && (
                          <p><span className="font-medium text-foreground">Root cause: </span><span className="text-muted-foreground font-mono">{log.rootCause}</span></p>
                        )}
                        {log.action && (
                          <p><span className="font-medium text-foreground">Triggered by: </span><span className="text-muted-foreground">{log.action}</span></p>
                        )}
                        {log.route && (
                          <p><span className="font-medium text-foreground">Route: </span><span className="text-muted-foreground font-mono">{log.route}</span></p>
                        )}
                        {log.suggestion && (
                          <p className="text-muted-foreground bg-muted rounded-md p-2">
                            <span className="font-medium text-foreground">Suggested fix: </span>{log.suggestion}
                          </p>
                        )}
                        {log.stack && (
                          <pre className="bg-muted rounded-md p-2 overflow-auto max-h-32 text-[10px] text-muted-foreground whitespace-pre-wrap">{log.stack}</pre>
                        )}
                        {log.browser && (
                          <p className="text-muted-foreground flex items-center gap-1.5">
                            {log.browser.online === false ? <WifiOff className="w-3 h-3" /> : <Wifi className="w-3 h-3" />}
                            {log.browser.userAgent}
                          </p>
                        )}
                        <div className="pt-1">
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => toggleResolved(log)}>
                            {log.resolved ? "Mark Unresolved" : "Mark Resolved"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
