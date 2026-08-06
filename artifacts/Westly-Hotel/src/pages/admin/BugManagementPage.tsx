import { useState, useMemo } from "react";
import { doc, setDoc, orderBy, limit, serverTimestamp, writeBatch, collection, query, where, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCollection } from "@/hooks/useFirebase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Bug, AlertTriangle, AlertCircle, Info, XCircle, CheckCircle2,
  Search, Download, ChevronDown, ChevronUp, RotateCcw, Trash2, HeartPulse,
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import { formatDateTime, toFirestoreDate } from "@/lib/utils";
import { DataError } from "@/components/ui/data-error";
import { useToast } from "@/hooks/use-toast";
import type { ErrorSeverity } from "@/lib/diagnostics";
import {
  type BugStatus, type BugPriority, BUG_STATUS_LABELS, BUG_PRIORITY_LABELS,
  RESOLVED_STATUSES, derivePriority,
} from "@/lib/bugTracker";

// ══════════════════════════════════════════════════════════════════════════
// BUG MANAGEMENT CENTER — a dedicated module, entirely separate from the
// Diagnostics page (own nav item, own route, own Firestore collections:
// bug_events + bugs). Super Admin only (enforced by ProtectedRoute in
// App.tsx AND by firestore.rules independently).
//
// Every bug on this page arrived here automatically — nobody files a bug
// report by hand. src/lib/bugTracker.ts is fed straight from the existing
// application-wide error funnel in src/lib/diagnostics.ts, so this page's
// only job is to GROUP the raw occurrence stream into bugs and let the
// Super Admin triage them (status/priority/notes), never to collect them.
// ══════════════════════════════════════════════════════════════════════════

interface BugEvent {
  id: string;
  fingerprint: string;
  title: string;
  message: string;
  category: string;
  severity: ErrorSeverity;
  module: string;
  page?: string | null;
  component?: string | null;
  functionInvolved?: string | null;
  stack?: string | null;
  rootCause?: string | null;
  suggestion?: string | null;
  userId?: string | null;
  userName?: string | null;
  userRole?: string | null;
  browserName?: string | null;
  os?: string | null;
  deviceType?: string | null;
  appVersion?: string | null;
  timestamp?: unknown;
}

interface BugMeta {
  id: string; // == fingerprint
  status?: BugStatus;
  priority?: BugPriority;
  notes?: string | null;
  resolvedAt?: unknown;
  updatedAt?: unknown;
}

interface BugGroup {
  fingerprint: string;
  title: string;
  message: string;
  category: string;
  severity: ErrorSeverity;
  module: string;
  page?: string | null;
  component?: string | null;
  functionInvolved?: string | null;
  stack?: string | null;
  rootCause?: string | null;
  suggestion?: string | null;
  userRoles: Set<string>;
  browsers: Set<string>;
  devices: Set<string>;
  appVersions: Set<string>;
  occurrenceCount: number;
  firstOccurrence: Date | null;
  lastOccurrence: Date | null;
  status: BugStatus;
  priority: BugPriority;
  notes: string | null;
  reopened: boolean;
  events: BugEvent[];
}

const SEVERITY_META: Record<ErrorSeverity, { label: string; color: string; icon: typeof Info }> = {
  info: { label: "Info", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400", icon: Info },
  warning: { label: "Warning", color: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400", icon: AlertTriangle },
  error: { label: "Error", color: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400", icon: AlertCircle },
  critical: { label: "Critical", color: "bg-red-200 text-red-900 dark:bg-red-950 dark:text-red-300 font-semibold", icon: XCircle },
};

const STATUS_COLOR: Record<BugStatus, string> = {
  new: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  investigating: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  in_progress: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  fixed: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400",
  verified: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  closed: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
  ignored: "bg-gray-100 text-gray-500 dark:bg-gray-900 dark:text-gray-500",
  duplicate: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
};

const PRIORITY_COLOR: Record<BugPriority, string> = {
  urgent: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  low: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
};

const PIE_COLORS = ["#ef4444", "#f97316", "#f59e0b", "#3b82f6", "#14b8a6", "#22c55e", "#a855f7", "#6b7280"];
const DAY_MS = 24 * 60 * 60 * 1000;

export default function BugManagementPage() {
  const { toast } = useToast();

  // Raw automatic capture stream — bounded window, real-time.
  const { data: events, loading, error, refetch } = useCollection<BugEvent>(
    "bug_events",
    [orderBy("timestamp", "desc"), limit(2000)]
  );
  // Curated triage state — one doc per grouped bug, Super Admin managed only.
  const { data: bugMetas } = useCollection<BugMeta>("bugs");

  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [moduleFilter, setModuleFilter] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [versionFilter, setVersionFilter] = useState("all");
  const [sortBy, setSortBy] = useState<"recent" | "frequent">("recent");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [savingNotes, setSavingNotes] = useState<Record<string, string>>({});

  const metaByFingerprint = useMemo(() => {
    const map = new Map<string, BugMeta>();
    for (const m of bugMetas) map.set(m.id, m);
    return map;
  }, [bugMetas]);

  // ── Group raw occurrences into bugs (client-side, deterministic) ────────
  const groups = useMemo<BugGroup[]>(() => {
    const map = new Map<string, BugGroup>();
    for (const e of events) {
      const meta = metaByFingerprint.get(e.fingerprint);
      const eventDate = toFirestoreDate(e.timestamp);
      let g = map.get(e.fingerprint);
      if (!g) {
        const defaultPriority = derivePriority(e.severity);
        g = {
          fingerprint: e.fingerprint,
          title: e.title || e.message,
          message: e.message,
          category: e.category,
          severity: e.severity,
          module: e.module,
          page: e.page,
          component: e.component,
          functionInvolved: e.functionInvolved,
          stack: e.stack,
          rootCause: e.rootCause,
          suggestion: e.suggestion,
          userRoles: new Set(),
          browsers: new Set(),
          devices: new Set(),
          appVersions: new Set(),
          occurrenceCount: 0,
          firstOccurrence: eventDate,
          lastOccurrence: eventDate,
          status: meta?.status ?? "new",
          priority: meta?.priority ?? defaultPriority,
          notes: meta?.notes ?? null,
          reopened: false,
          events: [],
        };
        map.set(e.fingerprint, g);
      }
      g.occurrenceCount += 1;
      g.events.push(e);
      if (e.userRole) g.userRoles.add(e.userRole);
      if (e.browserName) g.browsers.add(e.browserName);
      if (e.deviceType) g.devices.add(e.deviceType);
      if (e.appVersion) g.appVersions.add(e.appVersion);
      if (eventDate && (!g.firstOccurrence || eventDate < g.firstOccurrence)) g.firstOccurrence = eventDate;
      if (eventDate && (!g.lastOccurrence || eventDate > g.lastOccurrence)) g.lastOccurrence = eventDate;
      // The most recent occurrence's severity/stack/suggestion best represents current state.
      if (eventDate && g.lastOccurrence && eventDate.getTime() === g.lastOccurrence.getTime()) {
        g.severity = e.severity;
        g.stack = e.stack ?? g.stack;
        g.rootCause = e.rootCause ?? g.rootCause;
        g.suggestion = e.suggestion ?? g.suggestion;
      }
    }
    // Automatic regression detection: a bug marked fixed/verified/closed that
    // has a fresh occurrence after its resolvedAt is flagged, not silently
    // reset — the Super Admin still decides via the "Reopen" action.
    for (const g of map.values()) {
      const meta = metaByFingerprint.get(g.fingerprint);
      const resolvedAt = toFirestoreDate(meta?.resolvedAt);
      if (meta && RESOLVED_STATUSES.includes(meta.status ?? "new") && resolvedAt && g.lastOccurrence && g.lastOccurrence > resolvedAt) {
        g.reopened = true;
      }
    }
    return Array.from(map.values());
  }, [events, metaByFingerprint]);

  const modules = useMemo(() => ["all", ...Array.from(new Set(groups.map((g) => g.module))).sort()], [groups]);
  const categories = useMemo(() => ["all", ...Array.from(new Set(groups.map((g) => g.category))).sort()], [groups]);
  const roles = useMemo(() => ["all", ...Array.from(new Set(groups.flatMap((g) => Array.from(g.userRoles))))].sort(), [groups]);
  const versions = useMemo(() => ["all", ...Array.from(new Set(groups.flatMap((g) => Array.from(g.appVersions))))].sort(), [groups]);

  const filtered = useMemo(() => {
    const list = groups.filter((g) => {
      const matchSearch =
        !search ||
        g.title.toLowerCase().includes(search.toLowerCase()) ||
        g.message.toLowerCase().includes(search.toLowerCase()) ||
        g.module.toLowerCase().includes(search.toLowerCase()) ||
        g.component?.toLowerCase().includes(search.toLowerCase());
      const matchSeverity = severityFilter === "all" || g.severity === severityFilter;
      const matchStatus = statusFilter === "all" || g.status === statusFilter;
      const matchModule = moduleFilter === "all" || g.module === moduleFilter;
      const matchRole = roleFilter === "all" || g.userRoles.has(roleFilter);
      const matchCategory = categoryFilter === "all" || g.category === categoryFilter;
      const matchVersion = versionFilter === "all" || g.appVersions.has(versionFilter);
      return matchSearch && matchSeverity && matchStatus && matchModule && matchRole && matchCategory && matchVersion;
    });
    return list.sort((a, b) =>
      sortBy === "frequent"
        ? b.occurrenceCount - a.occurrenceCount
        : (b.lastOccurrence?.getTime() ?? 0) - (a.lastOccurrence?.getTime() ?? 0)
    );
  }, [groups, search, severityFilter, statusFilter, moduleFilter, roleFilter, categoryFilter, versionFilter, sortBy]);

  // ── Dashboard stats ──────────────────────────────────────────────────
  const now = Date.now();
  const stats = useMemo(() => {
    const open = groups.filter((g) => !RESOLVED_STATUSES.includes(g.status) && g.status !== "ignored" && g.status !== "duplicate");
    const critical = groups.filter((g) => g.priority === "urgent" && !RESOLVED_STATUSES.includes(g.status));
    const high = groups.filter((g) => g.priority === "high" && !RESOLVED_STATUSES.includes(g.status));
    const medium = groups.filter((g) => g.priority === "medium" && !RESOLVED_STATUSES.includes(g.status));
    const low = groups.filter((g) => g.priority === "low" && !RESOLVED_STATUSES.includes(g.status));
    const recentlyReported = groups.filter((g) => (g.firstOccurrence?.getTime() ?? 0) > now - DAY_MS);
    const recentlyFixed = groups.filter((g) => RESOLVED_STATUSES.includes(g.status) && (toFirestoreDate(metaByFingerprint.get(g.fingerprint)?.updatedAt)?.getTime() ?? 0) > now - 7 * DAY_MS);
    const reopened = groups.filter((g) => g.reopened);
    return { total: groups.length, open: open.length, critical: critical.length, high: high.length, medium: medium.length, low: low.length, recentlyReported: recentlyReported.length, recentlyFixed: recentlyFixed.length, reopened: reopened.length };
  }, [groups, now, metaByFingerprint]);

  const health = useMemo(() => {
    if (stats.critical > 0) return { label: "Critical", color: "text-red-600 bg-red-100 dark:bg-red-900/30 dark:text-red-400", icon: XCircle };
    if (stats.open >= 5 || stats.reopened > 0) return { label: "Degraded", color: "text-amber-600 bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400", icon: AlertTriangle };
    return { label: "Healthy", color: "text-green-600 bg-green-100 dark:bg-green-900/30 dark:text-green-400", icon: CheckCircle2 };
  }, [stats]);

  const byModule = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of groups) counts.set(g.module, (counts.get(g.module) ?? 0) + g.occurrenceCount);
    return Array.from(counts.entries()).map(([module, count]) => ({ module, count })).sort((a, b) => b.count - a.count).slice(0, 8);
  }, [groups]);

  const byStatus = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of groups) counts.set(g.status, (counts.get(g.status) ?? 0) + 1);
    return Array.from(counts.entries()).map(([status, count]) => ({ name: BUG_STATUS_LABELS[status as BugStatus] || status, value: count }));
  }, [groups]);

  const mostFrequent = useMemo(() => [...groups].sort((a, b) => b.occurrenceCount - a.occurrenceCount).slice(0, 5), [groups]);

  // ── Actions (Super Admin only, enforced by rules too) ─────────────────
  const updateBug = async (g: BugGroup, patch: Partial<{ status: BugStatus; priority: BugPriority; notes: string | null }>) => {
    try {
      const nextStatus = patch.status ?? g.status;
      const payload: Record<string, unknown> = {
        status: nextStatus,
        priority: patch.priority ?? g.priority,
        notes: patch.notes !== undefined ? patch.notes : (g.notes ?? null),
        updatedAt: serverTimestamp(),
      };
      // Only touch resolvedAt when the status itself is changing, so it
      // reflects the moment the bug most recently entered/left a resolved
      // state — that's what the "reopened" regression check compares against.
      if (patch.status) {
        payload.resolvedAt = RESOLVED_STATUSES.includes(nextStatus) ? serverTimestamp() : null;
      }
      await setDoc(doc(db, "bugs", g.fingerprint), payload, { merge: true });
    } catch {
      toast({ title: "Error", description: "Couldn't update that bug.", variant: "destructive" });
    }
  };

  const deleteBug = async (g: BugGroup) => {
    if (!window.confirm(`Delete "${g.title}" and all ${g.occurrenceCount} recorded occurrence(s)? This can't be undone.`)) return;
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, "bugs", g.fingerprint));
      const snap = await getDocs(query(collection(db, "bug_events"), where("fingerprint", "==", g.fingerprint)));
      snap.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      toast({ title: "Bug deleted", description: "The bug report and its history were removed." });
    } catch {
      toast({ title: "Error", description: "Couldn't delete that bug.", variant: "destructive" });
    }
  };

  const toggleExpanded = (fp: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(fp) ? next.delete(fp) : next.add(fp);
      return next;
    });
  };

  const exportCSV = () => {
    const csv = [
      ["Bug ID", "Title", "Severity", "Priority", "Status", "Module", "Category", "Occurrences", "First Seen", "Last Seen", "Component", "Root Cause"],
      ...filtered.map((g) => [
        g.fingerprint, g.title, g.severity, BUG_PRIORITY_LABELS[g.priority], BUG_STATUS_LABELS[g.status],
        g.module, g.category, String(g.occurrenceCount),
        formatDateTime(g.firstOccurrence), formatDateTime(g.lastOccurrence),
        g.component || "", g.rootCause || "",
      ]),
    ].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bugs-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const HealthIcon = health.icon;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif text-2xl font-bold flex items-center gap-2">
            <Bug className="w-6 h-6 text-primary" /> Bug Management Center
          </h1>
          <p className="text-muted-foreground text-sm">Every bug across the app, detected and tracked automatically — visible only to Super Admins</p>
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
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        {[
          { label: "Total Bugs", value: stats.total },
          { label: "Open Bugs", value: stats.open, className: "text-amber-600" },
          { label: "Critical", value: stats.critical, className: "text-red-600" },
          { label: "High", value: stats.high, className: "text-orange-600" },
          { label: "Medium", value: stats.medium, className: "text-amber-500" },
          { label: "Low", value: stats.low, className: "text-blue-600" },
          { label: "Reported (24h)", value: stats.recentlyReported },
          { label: "Fixed (7d)", value: stats.recentlyFixed, className: "text-green-600" },
        ].map((c) => (
          <Card key={c.label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{c.label}</p>
              <p className={`text-2xl font-bold mt-1 ${c.className || ""}`}>{c.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {stats.reopened > 0 && (
        <div className="flex items-center gap-2 text-sm bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 rounded-lg px-4 py-2.5">
          <RotateCcw className="w-4 h-4 shrink-0" />
          {stats.reopened} bug{stats.reopened > 1 ? "s" : ""} previously marked resolved {stats.reopened > 1 ? "have" : "has"} recurred — see the "Reopened" badge below.
        </div>
      )}

      {/* Charts */}
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Bugs by Module (occurrences)</CardTitle></CardHeader>
          <CardContent className="h-52 pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byModule} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" allowDecimals={false} fontSize={12} />
                <YAxis type="category" dataKey="module" width={130} fontSize={12} />
                <Tooltip />
                <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Bugs by Status</CardTitle></CardHeader>
          <CardContent className="h-52 pt-2">
            {byStatus.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">No bugs yet</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={byStatus} dataKey="value" nameKey="name" innerRadius={40} outerRadius={72}>
                    {byStatus.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {mostFrequent.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5"><HeartPulse className="w-4 h-4" /> Most Frequent Bugs</CardTitle></CardHeader>
          <CardContent className="pt-0 space-y-1.5">
            {mostFrequent.map((g) => (
              <div key={g.fingerprint} className="flex items-center justify-between text-sm py-1">
                <span className="truncate flex-1">{g.title}</span>
                <Badge variant="outline" className="ml-2 shrink-0">{g.occurrenceCount}×</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search title, message, module…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10" />
        </div>
        <Select value={severityFilter} onValueChange={setSeverityFilter}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Severity" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Severities</SelectItem>
            {(Object.keys(SEVERITY_META) as ErrorSeverity[]).map((s) => (<SelectItem key={s} value={s}>{SEVERITY_META[s].label}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {(Object.keys(BUG_STATUS_LABELS) as BugStatus[]).map((s) => (<SelectItem key={s} value={s}>{BUG_STATUS_LABELS[s]}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={moduleFilter} onValueChange={setModuleFilter}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Module" /></SelectTrigger>
          <SelectContent>{modules.map((m) => (<SelectItem key={m} value={m}>{m === "all" ? "All Modules" : m}</SelectItem>))}</SelectContent>
        </Select>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Error Type" /></SelectTrigger>
          <SelectContent>{categories.map((c) => (<SelectItem key={c} value={c}>{c === "all" ? "All Error Types" : c}</SelectItem>))}</SelectContent>
        </Select>
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-40"><SelectValue placeholder="User Role" /></SelectTrigger>
          <SelectContent>{roles.map((r) => (<SelectItem key={r} value={r}>{r === "all" ? "All Roles" : r.replace("_", " ")}</SelectItem>))}</SelectContent>
        </Select>
        <Select value={versionFilter} onValueChange={setVersionFilter}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Version" /></SelectTrigger>
          <SelectContent>{versions.map((v) => (<SelectItem key={v} value={v}>{v === "all" ? "All Versions" : v}</SelectItem>))}</SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={(v) => setSortBy(v as "recent" | "frequent")}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Sort" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">Most Recent</SelectItem>
            <SelectItem value="frequent">Most Frequent</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Bug list */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : error ? (
            <DataError message="We couldn't load the bug list." onRetry={refetch} />
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <CheckCircle2 className="w-10 h-10 mx-auto mb-2 opacity-30" />
              <p>No matching bugs — the app is quiet.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filtered.slice(0, 200).map((g) => {
                const meta = SEVERITY_META[g.severity] || SEVERITY_META.error;
                const SeverityIcon = meta.icon;
                const isOpen = expanded.has(g.fingerprint);
                const latest = g.events[0];
                return (
                  <div key={g.fingerprint} className="text-sm">
                    <button type="button" onClick={() => toggleExpanded(g.fingerprint)} className="w-full flex items-start gap-3 py-3 px-4 text-left hover:bg-muted/20">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium flex items-center gap-1 shrink-0 mt-0.5 ${meta.color}`}>
                        <SeverityIcon className="w-3 h-3" /> {meta.label}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{g.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {g.module}{g.component ? ` · ${g.component}` : ""} · {g.occurrenceCount} occurrence{g.occurrenceCount > 1 ? "s" : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {g.reopened && <Badge className="text-[10px] bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400">Reopened</Badge>}
                        <Badge className={`text-[10px] ${PRIORITY_COLOR[g.priority]}`}>{BUG_PRIORITY_LABELS[g.priority]}</Badge>
                        <Badge className={`text-[10px] ${STATUS_COLOR[g.status]}`}>{BUG_STATUS_LABELS[g.status]}</Badge>
                        <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:inline">{formatDateTime(g.lastOccurrence)}</span>
                        {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                      </div>
                    </button>
                    {isOpen && (
                      <div className="px-4 pb-4 pl-[4.5rem] space-y-3 text-xs">
                        <p><span className="font-medium text-foreground">Bug ID: </span><span className="text-muted-foreground font-mono">{g.fingerprint}</span></p>
                        <p><span className="font-medium text-foreground">Message: </span><span className="text-muted-foreground">{g.message}</span></p>
                        {g.rootCause && <p><span className="font-medium text-foreground">Root cause: </span><span className="text-muted-foreground font-mono">{g.rootCause}</span></p>}
                        {g.functionInvolved && <p><span className="font-medium text-foreground">Triggered by: </span><span className="text-muted-foreground">{g.functionInvolved}</span></p>}
                        {g.page && <p><span className="font-medium text-foreground">Page: </span><span className="text-muted-foreground font-mono">{g.page}</span></p>}
                        <p><span className="font-medium text-foreground">First seen: </span><span className="text-muted-foreground">{formatDateTime(g.firstOccurrence)}</span>{" · "}<span className="font-medium text-foreground">Last seen: </span><span className="text-muted-foreground">{formatDateTime(g.lastOccurrence)}</span></p>
                        {g.userRoles.size > 0 && <p><span className="font-medium text-foreground">Affected roles: </span><span className="text-muted-foreground">{Array.from(g.userRoles).join(", ")}</span></p>}
                        {(g.browsers.size > 0 || g.devices.size > 0) && (
                          <p><span className="font-medium text-foreground">Devices: </span><span className="text-muted-foreground">{[...g.browsers, ...g.devices].join(", ")}</span></p>
                        )}
                        {g.appVersions.size > 0 && <p><span className="font-medium text-foreground">App version: </span><span className="text-muted-foreground font-mono">{Array.from(g.appVersions).join(", ")}</span></p>}
                        {g.suggestion && (
                          <p className="text-muted-foreground bg-muted rounded-md p-2"><span className="font-medium text-foreground">Suggested fix: </span>{g.suggestion}</p>
                        )}
                        {g.stack && <pre className="bg-muted rounded-md p-2 overflow-auto max-h-32 text-[10px] text-muted-foreground whitespace-pre-wrap">{g.stack}</pre>}
                        {latest?.userName && <p><span className="font-medium text-foreground">Last reported by: </span><span className="text-muted-foreground">{latest.userName} ({latest.userRole})</span></p>}

                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <Select value={g.status} onValueChange={(v) => updateBug(g, { status: v as BugStatus })}>
                            <SelectTrigger className="h-7 text-xs w-40"><SelectValue /></SelectTrigger>
                            <SelectContent>{(Object.keys(BUG_STATUS_LABELS) as BugStatus[]).map((s) => (<SelectItem key={s} value={s}>{BUG_STATUS_LABELS[s]}</SelectItem>))}</SelectContent>
                          </Select>
                          <Select value={g.priority} onValueChange={(v) => updateBug(g, { priority: v as BugPriority })}>
                            <SelectTrigger className="h-7 text-xs w-32"><SelectValue /></SelectTrigger>
                            <SelectContent>{(Object.keys(BUG_PRIORITY_LABELS) as BugPriority[]).map((p) => (<SelectItem key={p} value={p}>{BUG_PRIORITY_LABELS[p]}</SelectItem>))}</SelectContent>
                          </Select>
                          {g.reopened && (
                            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => updateBug(g, { status: "new" })}>
                              <RotateCcw className="w-3 h-3" /> Reopen
                            </Button>
                          )}
                          <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-destructive hover:text-destructive" onClick={() => deleteBug(g)}>
                            <Trash2 className="w-3 h-3" /> Delete
                          </Button>
                        </div>

                        <div className="pt-1">
                          <Textarea
                            placeholder="Internal notes (fix details, PR link, etc.)"
                            value={savingNotes[g.fingerprint] ?? g.notes ?? ""}
                            onChange={(e) => setSavingNotes((prev) => ({ ...prev, [g.fingerprint]: e.target.value }))}
                            onBlur={(e) => updateBug(g, { notes: e.target.value || null })}
                            className="text-xs min-h-16"
                          />
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
