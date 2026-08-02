import { useCollection } from "@/hooks/useFirebase";
import { where } from "firebase/firestore";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { Sparkles, Wrench, CheckCircle, BedDouble } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { format } from "date-fns";
import { DataError } from "@/components/ui/data-error";
import { HOUSEKEEPING_PRIORITY_COLORS } from "@/lib/housekeeping";
import { cn } from "@/lib/utils";

// This widget shows ONLY the signed-in housekeeper's own queue and assigned
// rooms (Requirement 1) — never hotel-wide room counts, which is what this
// used to render before long-term room assignment existed.
export default function HousekeepingDashboard() {
  const { adminUser } = useAuth();

  const { data: queue, loading: l1, error: e1 } = useCollection<any>(
    "housekeeping_tasks",
    adminUser ? [where("assignedTo", "==", adminUser.id), where("status", "in", ["pending", "in_progress"])] : []
  );
  const { data: assignments, loading: l2, error: e2 } = useCollection<any>(
    "room_assignments",
    adminUser ? [where("housekeeperId", "==", adminUser.id), where("status", "==", "active")] : []
  );
  const dashLoading = l1 || l2;
  const dashError = e1 || e2;

  const urgentOrHigh = queue.filter((t: any) => t.priority === "urgent" || t.priority === "high");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-bold">Housekeeping</h1>
        <p className="text-muted-foreground text-sm">Welcome, {adminUser?.name} · {format(new Date(), "EEEE, MMMM d")}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {[
          { label: "My Queue", value: queue.length, color: "text-yellow-600", bg: "bg-yellow-50 dark:bg-yellow-900/10" },
          { label: "High Priority", value: urgentOrHigh.length, color: "text-red-600", bg: "bg-red-50 dark:bg-red-900/10" },
          { label: "My Rooms", value: assignments.length, color: "text-blue-600", bg: "bg-blue-50 dark:bg-blue-900/10" },
        ].map(s => (
          <Card key={s.label}>
            <CardContent className={`p-4 ${s.bg}`}>
              <p className={`text-3xl font-bold ${s.color}`}>{s.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Link href="/admin/housekeeping">
          <button className="w-full flex flex-col items-center justify-center gap-2 p-6 rounded-xl bg-primary text-primary-foreground hover:opacity-90 transition-opacity">
            <Sparkles className="w-6 h-6" />
            <span className="font-medium">My Housekeeping</span>
          </button>
        </Link>
        <Link href="/admin/maintenance">
          <button className="w-full flex flex-col items-center justify-center gap-2 p-6 rounded-xl bg-muted hover:bg-muted/80 transition-colors">
            <Wrench className="w-6 h-6" />
            <span className="font-medium">Maintenance</span>
          </button>
        </Link>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-yellow-500" /> My Cleaning Queue
          </CardTitle>
        </CardHeader>
        <CardContent>
          {dashLoading ? (
            <div className="flex items-center justify-center h-24">
              <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : dashError ? (
            <DataError message="We couldn't load your queue." />
          ) : queue.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-4 text-green-600">
              <CheckCircle className="w-5 h-5" />
              <span className="text-sm">Your queue is empty!</span>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {queue.slice(0, 9).map((task: any) => (
                <div key={task.id} className="flex items-center justify-between p-3 bg-yellow-50 dark:bg-yellow-900/10 rounded-lg">
                  <div className="flex items-center gap-2 min-w-0">
                    <BedDouble className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <p className="text-sm font-semibold truncate">Room {task.roomNumber}</p>
                  </div>
                  <Badge className={cn("text-[10px] shrink-0", HOUSEKEEPING_PRIORITY_COLORS[task.priority as keyof typeof HOUSEKEEPING_PRIORITY_COLORS])}>
                    {task.priority}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
