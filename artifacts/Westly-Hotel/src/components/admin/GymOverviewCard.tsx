import { useCollection } from "@/hooks/useFirebase";
import { where } from "firebase/firestore";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "wouter";
import { Dumbbell, ArrowRight } from "lucide-react";
import { effectiveMemberStatus } from "@/lib/gym";

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Compact gym-operations summary used on the Super Admin, Manager, and
 * Operations Manager dashboards — real-time counts (via onSnapshot in
 * useCollection) plus a link into the full Gym Reports page. Kept as one
 * shared component so the three dashboards can't drift out of sync on how
 * "active" or "today's visits" is computed.
 */
export default function GymOverviewCard() {
  const { data: members, loading: mLoading } = useCollection<any>("gym_members", [where("isDeleted", "!=", true)]);
  const { data: attendance, loading: aLoading } = useCollection<any>("gym_attendance", [where("isDeleted", "!=", true)]);

  const loading = mLoading || aLoading;
  const activeMembers = members.filter((m) => effectiveMemberStatus(m) === "active");
  const currentlyIn = attendance.filter((a) => !a.checkOutAt);
  const todaysVisits = attendance.filter((a) => a.dateKey === todayKey());

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-sm flex items-center gap-1.5"><Dumbbell className="w-4 h-4" /> Gym</h3>
          <Link href="/admin/gym/reports">
            <span className="text-xs text-primary flex items-center gap-1 cursor-pointer hover:underline">
              Reports <ArrowRight className="w-3 h-3" />
            </span>
          </Link>
        </div>
        {loading ? (
          <div className="h-14 flex items-center justify-center"><div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-xl font-bold text-green-600">{activeMembers.length}</p>
              <p className="text-[11px] text-muted-foreground">Active Members</p>
            </div>
            <div>
              <p className="text-xl font-bold text-blue-600">{currentlyIn.length}</p>
              <p className="text-[11px] text-muted-foreground">In Gym Now</p>
            </div>
            <div>
              <p className="text-xl font-bold">{todaysVisits.length}</p>
              <p className="text-[11px] text-muted-foreground">Visits Today</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
