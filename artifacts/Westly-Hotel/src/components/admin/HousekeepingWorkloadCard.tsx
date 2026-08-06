import { useMemo } from "react";
import { where } from "firebase/firestore";
import { useCollection, useDocument } from "@/hooks/useFirebase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Scale, Users } from "lucide-react";
import { dateKeyInTimezone, DEFAULT_HOTEL_TIME_SETTINGS } from "@/lib/housekeepingSchedule";
import { computeTaskWeight, DEFAULT_REBALANCE_THRESHOLD } from "@/lib/housekeepingBalance";

// ══════════════════════════════════════════════════════════════════════════
// Read-only visibility into today's fairness picture for the Ops
// Manager/Manager/Super Admin — how the daily auto-generated queue actually
// distributed today's check-outs and stay-over visits across whoever's on
// shift, not just each housekeeper's static room-count zone. Backed by the
// SAME dayKey/weight fields functions/_shared/housekeepingQueue.ts writes,
// so this is exactly what the balancing job saw, not a separate estimate.
// ══════════════════════════════════════════════════════════════════════════
export default function HousekeepingWorkloadCard() {
  const { data: hotelSettings } = useDocument<any>("settings", "hotel");
  const timezone = hotelSettings?.timezone || DEFAULT_HOTEL_TIME_SETTINGS.timezone;
  const todayKey = dateKeyInTimezone(new Date(), timezone);

  // depsKey: `todayKey` starts from DEFAULT_HOTEL_TIME_SETTINGS.timezone and
  // then updates once settings/hotel finishes loading — same field/op shape
  // either way, so without an explicit depsKey the hook would keep the
  // first (possibly wrong) day's query subscribed forever. See useCollection's
  // own doc comment on this exact pitfall.
  const { data: tasks, loading: tasksLoading } = useCollection<any>(
    "housekeeping_tasks",
    [where("dayKey", "==", todayKey), where("status", "in", ["pending", "in_progress"])],
    todayKey
  );
  const { data: shifts, loading: shiftsLoading } = useCollection<any>(
    "shifts",
    [where("role", "==", "housekeeping"), where("date", "==", todayKey)],
    todayKey
  );

  const onDutyToday = useMemo(
    () => Array.from(new Map(
      shifts.filter((s: any) => s.status === "scheduled").map((s: any) => [s.staffId, s.staffName || "Housekeeper"])
    ).entries()),
    [shifts]
  );

  const rows = useMemo(() => {
    const byId = new Map<string, { name: string; load: number; rooms: number }>();
    onDutyToday.forEach(([id, name]) => byId.set(id, { name, load: 0, rooms: 0 }));
    tasks.forEach((t: any) => {
      if (!t.assignedTo) return;
      const weight = typeof t.weight === "number" ? t.weight : computeTaskWeight(t.type, t.priority);
      const entry = byId.get(t.assignedTo) || { name: t.assignedToName || "Housekeeper", load: 0, rooms: 0 };
      entry.load += weight;
      entry.rooms += 1;
      byId.set(t.assignedTo, entry);
    });
    return Array.from(byId.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.load - a.load);
  }, [onDutyToday, tasks]);

  const avgLoad = rows.length > 0 ? rows.reduce((s, r) => s + r.load, 0) / rows.length : 0;
  const maxLoad = Math.max(1, ...rows.map(r => r.load));
  const unassignedToday = tasks.filter((t: any) => !t.assignedTo).length;

  if (tasksLoading || shiftsLoading) return null;
  if (rows.length === 0 && unassignedToday === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Scale className="h-4 w-4 text-indigo-500" /> Today's Workload Balance
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No housekeeping staff on shift today.</p>
        ) : (
          rows.map(r => {
            const overloaded = avgLoad > 0 && r.load > avgLoad * (1 + DEFAULT_REBALANCE_THRESHOLD);
            const pct = Math.round((r.load / maxLoad) * 100);
            return (
              <div key={r.id} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">{r.name}</span>
                  <span className="text-muted-foreground">
                    {r.rooms} room{r.rooms !== 1 ? "s" : ""} · {r.load.toFixed(1)} credits
                    {overloaded && <Badge variant="destructive" className="ml-1.5 text-[9px] align-middle">heavier day</Badge>}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={overloaded ? "h-full bg-orange-500" : "h-full bg-indigo-500"}
                    style={{ width: `${Math.max(pct, 3)}%` }}
                  />
                </div>
              </div>
            );
          })
        )}
        <div className="flex items-center justify-between pt-1 text-[11px] text-muted-foreground border-t">
          <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {onDutyToday.length} on shift today</span>
          {unassignedToday > 0 && <span className="text-red-600">{unassignedToday} unassigned</span>}
        </div>
      </CardContent>
    </Card>
  );
}
