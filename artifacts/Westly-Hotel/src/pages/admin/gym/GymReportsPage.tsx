import { useMemo } from "react";
import { useCollection } from "@/hooks/useFirebase";
import { where } from "firebase/firestore";
import { Card, CardContent } from "@/components/ui/card";
import { BarChart3, Users, TrendingUp, DollarSign, Activity, Loader2 } from "lucide-react";
import { DataError } from "@/components/ui/data-error";
import { effectiveMemberStatus } from "@/lib/gym";
import { toFirestoreDate } from "@/lib/utils";
import { startOfMonth, isWithinInterval, subDays, format } from "date-fns";

export default function GymReportsPage() {
  const { data: members, loading: mLoading, error: mError } = useCollection<any>("gym_members", [where("isDeleted", "!=", true)]);
  const { data: attendance, loading: aLoading, error: aError } = useCollection<any>("gym_attendance", [where("isDeleted", "!=", true)]);

  const loading = mLoading || aLoading;
  const error = mError || aError;

  const stats = useMemo(() => {
    const withStatus = members.map((m) => ({ ...m, effectiveStatus: effectiveMemberStatus(m) }));
    const counts = { active: 0, expired: 0, suspended: 0, cancelled: 0 };
    for (const m of withStatus) counts[m.effectiveStatus as keyof typeof counts]++;

    const monthStart = startOfMonth(new Date());
    const revenueThisMonth = withStatus.reduce((sum, m) => {
      const created = toFirestoreDate(m.createdAt);
      const updated = toFirestoreDate(m.updatedAt);
      const inMonth = (created && created >= monthStart) || (updated && updated >= monthStart);
      return inMonth ? sum + Number(m.packagePrice || 0) : sum;
    }, 0);

    const packageBreakdown: Record<string, number> = {};
    for (const m of withStatus) {
      if (m.effectiveStatus === "cancelled") continue;
      packageBreakdown[m.packageName || "Custom"] = (packageBreakdown[m.packageName || "Custom"] || 0) + 1;
    }

    // Visits per day, last 7 days
    const last7 = Array.from({ length: 7 }).map((_, i) => {
      const d = subDays(new Date(), 6 - i);
      const key = d.toISOString().slice(0, 10);
      const count = attendance.filter((a) => a.dateKey === key).length;
      return { label: format(d, "EEE"), count };
    });
    const maxVisits = Math.max(1, ...last7.map((d) => d.count));

    const expiringSoon = withStatus.filter((m) => {
      if (m.effectiveStatus !== "active") return false;
      const end = toFirestoreDate(m.endDate);
      if (!end) return false;
      return isWithinInterval(end, { start: new Date(), end: subDays(new Date(), -7) });
    });

    // Top members by total visit count
    const topMembers = [...withStatus].sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0)).slice(0, 5).filter((m) => (m.visitCount || 0) > 0);

    return { counts, revenueThisMonth, packageBreakdown, last7, maxVisits, expiringSoon, topMembers, total: withStatus.length };
  }, [members, attendance]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-bold flex items-center gap-2"><BarChart3 className="w-6 h-6" /> Gym Reports</h1>
        <p className="text-muted-foreground text-sm">Membership, attendance, and revenue analytics for the gym.</p>
      </div>

      {error && <DataError message="We couldn't load gym report data." />}

      {loading ? (
        <div className="flex items-center justify-center h-40"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard icon={Users} label="Total Members" value={stats.total} />
            <StatCard icon={Activity} label="Active" value={stats.counts.active} valueClass="text-green-600" />
            <StatCard icon={TrendingUp} label="Expiring ≤7d" value={stats.expiringSoon.length} valueClass="text-orange-600" />
            <StatCard icon={Users} label="Suspended" value={stats.counts.suspended} valueClass="text-orange-600" />
            <StatCard icon={DollarSign} label="Revenue (this month)" value={`$${stats.revenueThisMonth.toFixed(0)}`} valueClass="text-primary" />
          </div>

          {/* Visits last 7 days */}
          <Card>
            <CardContent className="p-5">
              <h3 className="font-semibold text-sm mb-4">Visits — Last 7 Days</h3>
              <div className="flex items-end gap-3 h-32">
                {stats.last7.map((d, i) => (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
                    <div className="w-full bg-primary/15 rounded-t-md relative flex items-end justify-center" style={{ height: "100%" }}>
                      <div className="w-full bg-primary rounded-t-md" style={{ height: `${(d.count / stats.maxVisits) * 100}%`, minHeight: d.count > 0 ? "4px" : "0" }} />
                    </div>
                    <span className="text-xs text-muted-foreground">{d.label}</span>
                    <span className="text-xs font-medium">{d.count}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Package breakdown */}
            <Card>
              <CardContent className="p-5">
                <h3 className="font-semibold text-sm mb-4">Members by Package</h3>
                {Object.keys(stats.packageBreakdown).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No membership data yet.</p>
                ) : (
                  <div className="space-y-2.5">
                    {Object.entries(stats.packageBreakdown).sort((a, b) => b[1] - a[1]).map(([name, count]) => (
                      <div key={name} className="flex items-center justify-between text-sm">
                        <span>{name}</span>
                        <span className="font-medium">{count}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Top members by visits */}
            <Card>
              <CardContent className="p-5">
                <h3 className="font-semibold text-sm mb-4">Most Active Members</h3>
                {stats.topMembers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No visits recorded yet.</p>
                ) : (
                  <div className="space-y-2.5">
                    {stats.topMembers.map((m) => (
                      <div key={m.id} className="flex items-center justify-between text-sm">
                        <span>{m.name}</span>
                        <span className="font-medium">{m.visitCount} visits</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <p className="text-xs text-muted-foreground">
            Revenue shown here reflects gym membership registrations and renewals recorded this month, and is not yet part of the unified Revenue Dashboard / Accountant approval ledger.
          </p>
        </>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, valueClass }: { icon: React.ComponentType<any>; label: string; value: string | number; valueClass?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1.5"><Icon className="w-3.5 h-3.5" /> {label}</div>
        <p className={`text-2xl font-bold ${valueClass || ""}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
