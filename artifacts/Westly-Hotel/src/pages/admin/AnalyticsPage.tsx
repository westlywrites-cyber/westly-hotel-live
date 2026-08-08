import { useState, useMemo, useEffect } from "react";
import { where, orderBy, limit as fsLimit, Timestamp } from "firebase/firestore";
import { ref, onValue } from "firebase/database";
import { rtdb } from "@/lib/firebase";
import { useCollection } from "@/hooks/useFirebase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Users, Activity, Eye, Search as SearchIcon, MousePointerClick, Clock,
  TrendingUp, Radio, UserRound,
} from "lucide-react";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { format, startOfDay, subDays } from "date-fns";
import { formatDateTime, timeAgo, toFirestoreDate } from "@/lib/utils";
import { DataError } from "@/components/ui/data-error";
import { labelForPath } from "@/hooks/useAnalytics";

// ── Types ─────────────────────────────────────────────────────────────────
interface AnalyticsSession {
  id: string;
  sessionId: string;
  userId?: string | null;
  userName?: string | null;
  userRole?: string | null;
  startedAt?: unknown;
  lastActiveAt?: unknown;
  endedAt?: unknown;
  pageViewCount?: number;
  entryPage?: string | null;
  exitPage?: string | null;
  deviceType?: string | null;
  isPublic?: boolean;
}

interface AnalyticsPageView {
  id: string;
  sessionId: string;
  userId?: string | null;
  userName?: string | null;
  userRole?: string | null;
  page: string;
  pageLabel?: string;
  previousPage?: string | null;
  durationMs?: number | null;
  entryIndex?: number;
  timestamp?: unknown;
}

interface AnalyticsSearchLog {
  id: string;
  sessionId: string;
  userId?: string | null;
  userName?: string | null;
  userRole?: string | null;
  query: string;
  module: string;
  resultsCount?: number | null;
  timestamp?: unknown;
}

interface AnalyticsInteraction {
  id: string;
  sessionId: string;
  userId?: string | null;
  userName?: string | null;
  userRole?: string | null;
  action: string;
  module: string;
  page?: string | null;
  status?: string | null;
  timestamp?: unknown;
}

interface PresenceEntry {
  userId?: string | null;
  userName?: string | null;
  userRole?: string | null;
  page?: string | null;
  lastActiveAt?: number;
}

// ── Date range helpers ───────────────────────────────────────────────────
type RangeKey = "today" | "yesterday" | "7d" | "30d" | "90d" | "custom";

function rangeToDates(rangeKey: RangeKey, customFrom: string, customTo: string): { from: Date; to: Date } {
  const now = new Date();
  switch (rangeKey) {
    case "today":
      return { from: startOfDay(now), to: now };
    case "yesterday": {
      const y = subDays(startOfDay(now), 1);
      return { from: y, to: startOfDay(now) };
    }
    case "7d":
      return { from: subDays(startOfDay(now), 7), to: now };
    case "30d":
      return { from: subDays(startOfDay(now), 30), to: now };
    case "90d":
      return { from: subDays(startOfDay(now), 90), to: now };
    case "custom":
      return {
        from: customFrom ? new Date(customFrom) : subDays(startOfDay(now), 7),
        to: customTo ? new Date(new Date(customTo).getTime() + 86_400_000) : now,
      };
  }
}

function tsOf(record: { timestamp?: unknown }): number {
  return toFirestoreDate(record.timestamp)?.getTime() ?? 0;
}

function topCounts(items: string[], n: number): { key: string; count: number }[] {
  const map = new Map<string, number>();
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, n);
}

// ── Small building blocks ────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value, sub }: { icon: typeof Users; label: string; value: string | number; sub?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
          </div>
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
      </CardContent>
    </Card>
  );
}

function RankedList({ rows, valueLabel = "views" }: { rows: { key: string; count: number }[]; valueLabel?: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground py-4">No data in this range.</p>;
  const max = rows[0]?.count || 1;
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="truncate max-w-[70%]" title={r.key}>{r.key}</span>
            <span className="text-muted-foreground">{r.count} {valueLabel}</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary rounded-full" style={{ width: `${(r.count / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

const ROLE_FILTERS = [
  "super_admin", "manager", "receptionist", "staff", "waiter", "accountant", "housekeeping",
  "bar_attendant", "laundry_valet", "operations_manager", "maintenance_technician",
  "security_guard", "driver", "restaurant_attendant", "kitchen_staff", "gym_staff", "guest",
];

// ══════════════════════════════════════════════════════════════════════════
export default function AnalyticsPage() {
  const [rangeKey, setRangeKey] = useState<RangeKey>("7d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const { from, to } = useMemo(() => rangeToDates(rangeKey, customFrom, customTo), [rangeKey, customFrom, customTo]);
  const fromTs = useMemo(() => Timestamp.fromDate(from), [from]);
  const rangeDepsKey = `${from.getTime()}:${to.getTime()}`;

  // Bounded reads (matches the pattern in DiagnosticsPage) — this is a
  // recent-activity dashboard, not a full historical export.
  const sessionsQ = useCollection<AnalyticsSession>(
    "analytics_sessions",
    [where("startedAt", ">=", fromTs), orderBy("startedAt", "desc"), fsLimit(3000)],
    rangeDepsKey
  );
  const pageViewsQ = useCollection<AnalyticsPageView>(
    "analytics_page_views",
    [where("timestamp", ">=", fromTs), orderBy("timestamp", "desc"), fsLimit(5000)],
    rangeDepsKey
  );
  const searchLogsQ = useCollection<AnalyticsSearchLog>(
    "analytics_search_logs",
    [where("timestamp", ">=", fromTs), orderBy("timestamp", "desc"), fsLimit(3000)],
    rangeDepsKey
  );
  const interactionsQ = useCollection<AnalyticsInteraction>(
    "analytics_interactions",
    [where("timestamp", ">=", fromTs), orderBy("timestamp", "desc"), fsLimit(5000)],
    rangeDepsKey
  );

  const anyError = sessionsQ.error || pageViewsQ.error || searchLogsQ.error || interactionsQ.error;
  const anyLoading = sessionsQ.loading || pageViewsQ.loading || searchLogsQ.loading || interactionsQ.loading;

  // Apply role filter + the "to" bound client-side (Firestore rules cap
  // this to a single range where(); loading everything from `from` and
  // trimming past `to` avoids a second composite condition/index).
  const sessions = useMemo(
    () => sessionsQ.data.filter((s) => tsOf({ timestamp: s.startedAt }) <= to.getTime() && (roleFilter === "all" || (s.userRole || "guest") === roleFilter)),
    [sessionsQ.data, to, roleFilter]
  );
  const pageViews = useMemo(
    () => pageViewsQ.data.filter((p) => tsOf(p) <= to.getTime() && (roleFilter === "all" || (p.userRole || "guest") === roleFilter)),
    [pageViewsQ.data, to, roleFilter]
  );
  const searchLogs = useMemo(
    () => searchLogsQ.data.filter((s) => tsOf(s) <= to.getTime() && (roleFilter === "all" || (s.userRole || "guest") === roleFilter)),
    [searchLogsQ.data, to, roleFilter]
  );
  const interactions = useMemo(
    () => interactionsQ.data.filter((i) => tsOf(i) <= to.getTime() && (roleFilter === "all" || (i.userRole || "guest") === roleFilter)),
    [interactionsQ.data, to, roleFilter]
  );

  // ── Real-time presence (RTDB) ──────────────────────────────────────────
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  useEffect(() => {
    const unsub = onValue(
      ref(rtdb, "presence"),
      (snap) => {
        if (!snap.exists()) { setPresence([]); return; }
        const now = Date.now();
        const entries: PresenceEntry[] = [];
        snap.forEach((child) => {
          const v = child.val() as PresenceEntry;
          // 3-minute staleness window — a closed/crashed tab without a
          // clean disconnect event should still drop off promptly.
          if (v?.lastActiveAt && now - v.lastActiveAt < 3 * 60 * 1000) entries.push(v);
        });
        setPresence(entries);
      },
      () => setPresence([])
    );
    return () => unsub();
  }, []);

  // ── Overview stats ─────────────────────────────────────────────────────
  const overview = useMemo(() => {
    const distinctUsers = new Set(sessions.map((s) => s.userId || `guest:${s.sessionId}`));
    const userFirstSeen = new Map<string, number>();
    for (const s of sessions) {
      const key = s.userId || `guest:${s.sessionId}`;
      const t = tsOf({ timestamp: s.startedAt });
      if (!userFirstSeen.has(key) || t < userFirstSeen.get(key)!) userFirstSeen.set(key, t);
    }
    const sessionsByUser = new Map<string, number>();
    for (const s of sessions) {
      const key = s.userId || `guest:${s.sessionId}`;
      sessionsByUser.set(key, (sessionsByUser.get(key) ?? 0) + 1);
    }
    const returningUsers = [...sessionsByUser.values()].filter((c) => c > 1).length;
    const newUsers = sessionsByUser.size - returningUsers;

    const durations = sessions
      .map((s) => {
        const start = tsOf({ timestamp: s.startedAt });
        const end = toFirestoreDate(s.endedAt)?.getTime() || tsOf({ timestamp: s.lastActiveAt }) || start;
        return end - start;
      })
      .filter((d) => d > 0 && d < 4 * 60 * 60 * 1000); // discard >4h outliers (abandoned tabs)
    const avgSessionDuration = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    const pageCounts = topCounts(pageViews.map((p) => p.pageLabel || labelForPath(p.page)), 1);
    const actionCounts = topCounts(interactions.map((i) => i.action), 1);

    return {
      totalUsers: distinctUsers.size,
      activeUsers: presence.length,
      newUsers,
      returningUsers,
      totalSessions: sessions.length,
      avgSessionDuration,
      totalPageViews: pageViews.length,
      mostVisitedPage: pageCounts[0]?.key || "—",
      mostUsedFeature: actionCounts[0]?.key || "—",
    };
  }, [sessions, pageViews, interactions, presence]);

  // ── Navigation analytics ───────────────────────────────────────────────
  const navigation = useMemo(() => {
    const pageLabels = pageViews.map((p) => p.pageLabel || labelForPath(p.page));
    const mostVisited = topCounts(pageLabels, 10);
    const leastVisited = [...topCounts(pageLabels, 1000)].sort((a, b) => a.count - b.count).slice(0, 10);

    const paths = pageViews
      .filter((p) => p.previousPage)
      .map((p) => `${labelForPath(p.previousPage!)} → ${p.pageLabel || labelForPath(p.page)}`);
    const commonPaths = topCounts(paths, 10);

    const durationByPage = new Map<string, number[]>();
    for (const p of pageViews) {
      if (typeof p.durationMs === "number" && p.durationMs > 0) {
        const key = p.pageLabel || labelForPath(p.page);
        const arr = durationByPage.get(key) || [];
        arr.push(p.durationMs);
        durationByPage.set(key, arr);
      }
    }
    const avgTimePerPage = [...durationByPage.entries()]
      .map(([key, arr]) => ({ key, avgMs: arr.reduce((a, b) => a + b, 0) / arr.length }))
      .sort((a, b) => b.avgMs - a.avgMs)
      .slice(0, 10);

    const entryPages = topCounts(pageViews.filter((p) => p.entryIndex === 1).map((p) => p.pageLabel || labelForPath(p.page)), 8);
    const exitPages = topCounts(sessions.filter((s) => s.exitPage).map((s) => labelForPath(s.exitPage!)), 8);

    return { mostVisited, leastVisited, commonPaths, avgTimePerPage, entryPages, exitPages };
  }, [pageViews, sessions]);

  // ── Search analytics ───────────────────────────────────────────────────
  const searchAnalytics = useMemo(() => {
    const mostSearched = topCounts(searchLogs.map((s) => s.query.toLowerCase()), 15);
    const noResults = searchLogs.filter((s) => s.resultsCount === 0).length;
    const byModule = topCounts(searchLogs.map((s) => s.module), 10);

    const byDay = new Map<string, number>();
    for (const s of searchLogs) {
      const d = toFirestoreDate(s.timestamp);
      if (!d) continue;
      const key = format(d, "MMM d");
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
    const overTime = [...byDay.entries()].map(([date, count]) => ({ date, count }));

    return { mostSearched, noResults, byModule, overTime, total: searchLogs.length };
  }, [searchLogs]);

  // ── Interaction analytics ──────────────────────────────────────────────
  const interactionAnalytics = useMemo(() => {
    const mostClicked = topCounts(interactions.map((i) => i.action), 12);
    const byModule = topCounts(interactions.map((i) => i.module), 10);
    const submitted = topCounts(interactions.filter((i) => /submitted/i.test(i.action)).map((i) => i.action), 10);

    const byRoleModule = new Map<string, number>();
    for (const i of interactions) {
      const key = `${i.userRole || "guest"} · ${i.module}`;
      byRoleModule.set(key, (byRoleModule.get(key) ?? 0) + 1);
    }
    const roleModuleRows = [...byRoleModule.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, 12);

    const byDay = new Map<string, number>();
    for (const i of interactions) {
      const d = toFirestoreDate(i.timestamp);
      if (!d) continue;
      const key = format(d, "MMM d");
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
    const overTime = [...byDay.entries()].map(([date, count]) => ({ date, count }));

    return { mostClicked, byModule, submitted, roleModuleRows, overTime };
  }, [interactions]);

  // ── Session analytics ──────────────────────────────────────────────────
  const sessionAnalytics = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const s of sessions) {
      const d = toFirestoreDate(s.startedAt);
      if (!d) continue;
      const key = format(d, "MMM d");
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
    const overTime = [...byDay.entries()].map(([date, count]) => ({ date, count }));

    const byHour = new Array(24).fill(0);
    for (const s of sessions) {
      const d = toFirestoreDate(s.startedAt);
      if (d) byHour[d.getHours()]++;
    }
    const peakHours = byHour.map((count, hour) => ({ hour: `${hour}:00`, count }));

    const avgPagesPerSession = sessions.length
      ? sessions.reduce((sum, s) => sum + (s.pageViewCount || 0), 0) / sessions.length
      : 0;

    const now = Date.now();
    const dau = new Set(sessions.filter((s) => tsOf({ timestamp: s.startedAt }) > now - 24 * 3600 * 1000).map((s) => s.userId || s.sessionId)).size;
    const wau = new Set(sessions.filter((s) => tsOf({ timestamp: s.startedAt }) > now - 7 * 24 * 3600 * 1000).map((s) => s.userId || s.sessionId)).size;
    const mau = new Set(sessions.filter((s) => tsOf({ timestamp: s.startedAt }) > now - 30 * 24 * 3600 * 1000).map((s) => s.userId || s.sessionId)).size;

    return { overTime, peakHours, avgPagesPerSession, dau, wau, mau };
  }, [sessions]);

  // ── Individual user list + timeline ────────────────────────────────────
  const userList = useMemo(() => {
    const map = new Map<string, { userId: string; userName: string; userRole: string; sessions: number; lastActive: number }>();
    for (const s of sessions) {
      if (!s.userId) continue; // only named staff/admin accounts, not anonymous guests
      const existing = map.get(s.userId);
      const lastActive = tsOf({ timestamp: s.lastActiveAt }) || tsOf({ timestamp: s.startedAt });
      if (existing) {
        existing.sessions++;
        existing.lastActive = Math.max(existing.lastActive, lastActive);
      } else {
        map.set(s.userId, { userId: s.userId, userName: s.userName || "Unknown", userRole: s.userRole || "—", sessions: 1, lastActive });
      }
    }
    return [...map.values()].sort((a, b) => b.lastActive - a.lastActive);
  }, [sessions]);

  const userTimeline = useMemo(() => {
    if (!selectedUserId) return [];
    type Event = { type: "page" | "search" | "interaction"; label: string; detail?: string; time: number };
    const events: Event[] = [];
    for (const p of pageViews.filter((p) => p.userId === selectedUserId)) {
      events.push({ type: "page", label: `Visited ${p.pageLabel || labelForPath(p.page)}`, detail: p.durationMs ? `${formatDuration(p.durationMs)} on page` : undefined, time: tsOf(p) });
    }
    for (const s of searchLogs.filter((s) => s.userId === selectedUserId)) {
      events.push({ type: "search", label: `Searched "${s.query}"`, detail: `${s.module}${typeof s.resultsCount === "number" ? ` · ${s.resultsCount} results` : ""}`, time: tsOf(s) });
    }
    for (const i of interactions.filter((i) => i.userId === selectedUserId)) {
      events.push({ type: "interaction", label: i.action, detail: i.module, time: tsOf(i) });
    }
    return events.sort((a, b) => b.time - a.time).slice(0, 200);
  }, [selectedUserId, pageViews, searchLogs, interactions]);

  if (anyError) {
    return <DataError message="Couldn't load usage analytics." detail={anyError.message} onRetry={sessionsQ.refetch} />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Activity className="h-6 w-6" /> Usage Analytics</h1>
        <p className="text-sm text-muted-foreground">How users navigate, search, and interact with Westly Hotel — visible only to Super Admin.</p>
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={rangeKey} onValueChange={(v) => setRangeKey(v as RangeKey)}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="yesterday">Yesterday</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="90d">Last 90 days</SelectItem>
            <SelectItem value="custom">Custom range</SelectItem>
          </SelectContent>
        </Select>
        {rangeKey === "custom" && (
          <>
            <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="w-[150px]" />
            <span className="text-muted-foreground text-sm">to</span>
            <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="w-[150px]" />
          </>
        )}
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-[170px]"><SelectValue placeholder="All roles" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            {ROLE_FILTERS.map((r) => (
              <SelectItem key={r} value={r}>{r.replace(/_/g, " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {anyLoading && <span className="text-xs text-muted-foreground">Loading…</span>}
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="navigation">Navigation</TabsTrigger>
          <TabsTrigger value="search">Search</TabsTrigger>
          <TabsTrigger value="interactions">Interactions</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="realtime">Real-Time</TabsTrigger>
          <TabsTrigger value="users">User Activity</TabsTrigger>
        </TabsList>

        {/* ── Overview ── */}
        <TabsContent value="overview" className="space-y-4 mt-4">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <StatCard icon={Users} label="Total Users" value={overview.totalUsers} />
            <StatCard icon={Radio} label="Active Now" value={overview.activeUsers} sub="Live, last 3 min" />
            <StatCard icon={UserRound} label="New Users" value={overview.newUsers} />
            <StatCard icon={UserRound} label="Returning Users" value={overview.returningUsers} />
            <StatCard icon={Activity} label="Total Sessions" value={overview.totalSessions} />
            <StatCard icon={Clock} label="Avg Session Duration" value={formatDuration(overview.avgSessionDuration)} />
            <StatCard icon={Eye} label="Total Page Views" value={overview.totalPageViews} />
            <StatCard icon={TrendingUp} label="Most Visited Page" value={overview.mostVisitedPage} />
            <StatCard icon={MousePointerClick} label="Most Used Feature" value={overview.mostUsedFeature} />
          </div>
        </TabsContent>

        {/* ── Navigation ── */}
        <TabsContent value="navigation" className="space-y-4 mt-4">
          <div className="grid md:grid-cols-2 gap-4">
            <Card><CardHeader><CardTitle className="text-base">Most Visited Pages</CardTitle></CardHeader><CardContent><RankedList rows={navigation.mostVisited} /></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">Least Visited Pages</CardTitle></CardHeader><CardContent><RankedList rows={navigation.leastVisited} /></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">Common Navigation Paths</CardTitle></CardHeader><CardContent><RankedList rows={navigation.commonPaths} valueLabel="times" /></CardContent></Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Average Time Spent Per Page</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {navigation.avgTimePerPage.length === 0 && <p className="text-sm text-muted-foreground py-4">No page-duration data yet.</p>}
                {navigation.avgTimePerPage.map((r) => (
                  <div key={r.key} className="flex items-center justify-between text-sm">
                    <span className="truncate max-w-[70%]" title={r.key}>{r.key}</span>
                    <Badge variant="secondary">{formatDuration(r.avgMs)}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card><CardHeader><CardTitle className="text-base">Most Common Entry Pages</CardTitle></CardHeader><CardContent><RankedList rows={navigation.entryPages} /></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">Most Common Exit Pages</CardTitle></CardHeader><CardContent><RankedList rows={navigation.exitPages} /></CardContent></Card>
          </div>
        </TabsContent>

        {/* ── Search ── */}
        <TabsContent value="search" className="space-y-4 mt-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <StatCard icon={SearchIcon} label="Total Searches" value={searchAnalytics.total} />
            <StatCard icon={SearchIcon} label="Searches With No Results" value={searchAnalytics.noResults} />
            <StatCard icon={SearchIcon} label="Search Modules" value={searchAnalytics.byModule.length} />
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <Card><CardHeader><CardTitle className="text-base">Most Searched Terms</CardTitle></CardHeader><CardContent><RankedList rows={searchAnalytics.mostSearched} valueLabel="searches" /></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">Search Activity by Module</CardTitle></CardHeader><CardContent><RankedList rows={searchAnalytics.byModule} valueLabel="searches" /></CardContent></Card>
          </div>
          <Card>
            <CardHeader><CardTitle className="text-base">Search Activity Over Time</CardTitle></CardHeader>
            <CardContent>
              {searchAnalytics.overTime.length === 0 ? <p className="text-sm text-muted-foreground py-4">No data.</p> : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={searchAnalytics.overTime}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" fontSize={12} />
                    <YAxis fontSize={12} allowDecimals={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="count" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Interactions ── */}
        <TabsContent value="interactions" className="space-y-4 mt-4">
          <div className="grid md:grid-cols-2 gap-4">
            <Card><CardHeader><CardTitle className="text-base">Most Clicked Actions</CardTitle></CardHeader><CardContent><RankedList rows={interactionAnalytics.mostClicked} valueLabel="clicks" /></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">Most Used Features (by module)</CardTitle></CardHeader><CardContent><RankedList rows={interactionAnalytics.byModule} valueLabel="events" /></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">Most Frequently Submitted Forms</CardTitle></CardHeader><CardContent><RankedList rows={interactionAnalytics.submitted} valueLabel="submissions" /></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">Feature Usage by Role</CardTitle></CardHeader><CardContent><RankedList rows={interactionAnalytics.roleModuleRows} valueLabel="events" /></CardContent></Card>
          </div>
          <Card>
            <CardHeader><CardTitle className="text-base">Interaction Trends Over Time</CardTitle></CardHeader>
            <CardContent>
              {interactionAnalytics.overTime.length === 0 ? <p className="text-sm text-muted-foreground py-4">No data.</p> : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={interactionAnalytics.overTime}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" fontSize={12} />
                    <YAxis fontSize={12} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Sessions ── */}
        <TabsContent value="sessions" className="space-y-4 mt-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard icon={Users} label="Daily Active Users" value={sessionAnalytics.dau} />
            <StatCard icon={Users} label="Weekly Active Users" value={sessionAnalytics.wau} />
            <StatCard icon={Users} label="Monthly Active Users" value={sessionAnalytics.mau} />
            <StatCard icon={Eye} label="Avg Pages / Session" value={sessionAnalytics.avgPagesPerSession.toFixed(1)} />
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-base">Sessions Over Time</CardTitle></CardHeader>
              <CardContent>
                {sessionAnalytics.overTime.length === 0 ? <p className="text-sm text-muted-foreground py-4">No data.</p> : (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={sessionAnalytics.overTime}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" fontSize={12} />
                      <YAxis fontSize={12} allowDecimals={false} />
                      <Tooltip />
                      <Line type="monotone" dataKey="count" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Peak Usage Times</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={sessionAnalytics.peakHours}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="hour" fontSize={10} interval={2} />
                    <YAxis fontSize={12} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── Real-Time ── */}
        <TabsContent value="realtime" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Radio className="h-4 w-4 text-green-600" /> Currently Active ({presence.length})</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {presence.length === 0 && <p className="text-sm text-muted-foreground py-4">No one is currently active.</p>}
              {presence.map((p, idx) => (
                <div key={idx} className="flex items-center justify-between text-sm border-b last:border-0 py-2">
                  <div>
                    <span className="font-medium capitalize">{(p.userRole || "guest").replace(/_/g, " ")}</span>
                    {p.userName && p.userName !== "Guest" && <span className="text-muted-foreground"> — {p.userName}</span>}
                  </div>
                  <Badge variant="outline">{labelForPath(p.page || "/")}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── User Activity ── */}
        <TabsContent value="users" className="space-y-4 mt-4">
          <div className="grid md:grid-cols-3 gap-4">
            <Card className="md:col-span-1">
              <CardHeader><CardTitle className="text-base">Staff & Admin Users</CardTitle></CardHeader>
              <CardContent className="space-y-1 max-h-[500px] overflow-y-auto">
                {userList.length === 0 && <p className="text-sm text-muted-foreground py-4">No signed-in activity in this range.</p>}
                {userList.map((u) => (
                  <button
                    key={u.userId}
                    onClick={() => setSelectedUserId(u.userId)}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm hover:bg-muted transition-colors ${selectedUserId === u.userId ? "bg-muted" : ""}`}
                  >
                    <div className="font-medium">{u.userName}</div>
                    <div className="text-xs text-muted-foreground capitalize">{u.userRole.replace(/_/g, " ")} · {u.sessions} session{u.sessions === 1 ? "" : "s"} · {timeAgo(new Date(u.lastActive))}</div>
                  </button>
                ))}
              </CardContent>
            </Card>
            <Card className="md:col-span-2">
              <CardHeader><CardTitle className="text-base">Activity Timeline</CardTitle></CardHeader>
              <CardContent>
                {!selectedUserId ? (
                  <p className="text-sm text-muted-foreground py-4">Select a user to see their chronological activity.</p>
                ) : userTimeline.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4">No recorded activity for this user in this range.</p>
                ) : (
                  <div className="space-y-3 max-h-[500px] overflow-y-auto">
                    {userTimeline.map((e, idx) => (
                      <div key={idx} className="flex gap-3 text-sm">
                        <div className="mt-1">
                          {e.type === "page" && <Eye className="h-3.5 w-3.5 text-blue-500" />}
                          {e.type === "search" && <SearchIcon className="h-3.5 w-3.5 text-amber-500" />}
                          {e.type === "interaction" && <MousePointerClick className="h-3.5 w-3.5 text-emerald-500" />}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span>{e.label}</span>
                            {e.detail && <span className="text-xs text-muted-foreground">· {e.detail}</span>}
                          </div>
                          <div className="text-xs text-muted-foreground">{formatDateTime(new Date(e.time))}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
