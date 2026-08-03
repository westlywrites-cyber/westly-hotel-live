import { useAuth } from "@/contexts/AuthContext";
import { useCollection } from "@/hooks/useFirebase";
import { where } from "firebase/firestore";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "wouter";
import { LogIn, Users, CalendarClock, BarChart3, Dumbbell } from "lucide-react";
import { DataError } from "@/components/ui/data-error";
import { effectiveMemberStatus, daysUntilExpiry } from "@/lib/gym";
import { format } from "date-fns";

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export default function GymStaffDashboard() {
  const { adminUser } = useAuth();
  const { data: members, loading: mLoading, error: mError } = useCollection<any>("gym_members", [where("isDeleted", "!=", true)]);
  const { data: attendance, loading: aLoading, error: aError } = useCollection<any>("gym_attendance", [where("isDeleted", "!=", true)]);

  const loading = mLoading || aLoading;
  const error = mError || aError;

  const activeMembers = members.filter((m) => effectiveMemberStatus(m) === "active");
  const currentlyIn = attendance.filter((a) => !a.checkOutAt);
  const todaysVisits = attendance.filter((a) => a.dateKey === todayKey());
  const expiringSoon = activeMembers.filter((m) => {
    const d = daysUntilExpiry(m.endDate);
    return d !== null && d >= 0 && d <= 7;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-bold flex items-center gap-2"><Dumbbell className="w-6 h-6" /> Gym Desk</h1>
        <p className="text-muted-foreground text-sm">Welcome, {adminUser?.name} · {format(new Date(), "EEEE, MMMM d")}</p>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <QuickLink href="/admin/gym/checkin" icon={LogIn} label="Check-In / Out" primary />
        <QuickLink href="/admin/gym/members" icon={Users} label="Members" />
        <QuickLink href="/admin/gym/attendance" icon={CalendarClock} label="Attendance Log" />
        <QuickLink href="/admin/gym/reports" icon={BarChart3} label="Reports" />
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-32"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>
      ) : error ? (
        <DataError message="We couldn't load gym data." />
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: "Active Members", value: activeMembers.length, color: "text-green-600" },
              { label: "Currently In Gym", value: currentlyIn.length, color: "text-blue-600" },
              { label: "Visits Today", value: todaysVisits.length, color: "text-primary" },
              { label: "Expiring ≤ 7 Days", value: expiringSoon.length, color: "text-orange-600" },
            ].map((s) => (
              <Card key={s.label}>
                <CardContent className="p-4">
                  <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                  <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {expiringSoon.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <h3 className="font-semibold text-sm mb-3">Memberships Expiring Soon</h3>
                <div className="space-y-2">
                  {expiringSoon.slice(0, 5).map((m) => (
                    <div key={m.id} className="flex items-center justify-between text-sm">
                      <span>{m.name}</span>
                      <span className="text-orange-600 text-xs font-medium">{daysUntilExpiry(m.endDate)}d left</span>
                    </div>
                  ))}
                </div>
                {expiringSoon.length > 5 && (
                  <Link href="/admin/gym/members"><span className="text-xs text-primary mt-2 inline-block cursor-pointer">View all →</span></Link>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function QuickLink({ href, icon: Icon, label, primary }: { href: string; icon: React.ComponentType<any>; label: string; primary?: boolean }) {
  return (
    <Link href={href}>
      <button className={`w-full flex flex-col items-center justify-center gap-2 p-6 rounded-xl transition-opacity hover:opacity-90 ${primary ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
        <Icon className={`w-7 h-7 ${primary ? "" : "text-muted-foreground"}`} />
        <span className="font-semibold text-sm text-center">{label}</span>
      </button>
    </Link>
  );
}
