import { useState, useMemo } from "react";
import { useCollection } from "@/hooks/useFirebase";
import { where } from "firebase/firestore";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CalendarClock, Search, X } from "lucide-react";
import { DataError } from "@/components/ui/data-error";

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function fmtTime(ts: any) {
  return ts?.toDate ? ts.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}

function durationLabel(checkInAt: any, checkOutAt: any) {
  if (!checkInAt?.toDate || !checkOutAt?.toDate) return "—";
  const mins = Math.round((checkOutAt.toDate().getTime() - checkInAt.toDate().getTime()) / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export default function GymAttendancePage() {
  const { data: attendance, loading, error } = useCollection<any>("gym_attendance", [where("isDeleted", "!=", true)]);
  const [date, setDate] = useState(todayKey());
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return attendance
      .filter((a) => !date || a.dateKey === date)
      .filter((a) => !search || a.memberName?.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => (b.checkInAt?.seconds || 0) - (a.checkInAt?.seconds || 0));
  }, [attendance, date, search]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-serif text-2xl font-bold flex items-center gap-2"><CalendarClock className="w-6 h-6" /> Gym Attendance History</h1>
        <p className="text-muted-foreground text-sm">Full check-in / check-out log across all members.</p>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
        {date && <Button variant="ghost" size="sm" onClick={() => setDate("")} className="gap-1 text-xs"><X className="w-3.5 h-3.5" />Clear date</Button>}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search by member name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>
      ) : error ? (
        <DataError message="We couldn't load attendance history." />
      ) : filtered.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground text-sm">No visits match your filters.</CardContent></Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Date</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Member</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Check-In</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Check-Out</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Duration</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Staff</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                      <td className="py-2.5 px-4 text-muted-foreground">{a.dateKey}</td>
                      <td className="py-2.5 px-4 font-medium">{a.memberName}</td>
                      <td className="py-2.5 px-4 text-muted-foreground">{fmtTime(a.checkInAt)}</td>
                      <td className="py-2.5 px-4 text-muted-foreground">{a.checkOutAt ? fmtTime(a.checkOutAt) : <span className="text-green-600 font-medium">Still in</span>}</td>
                      <td className="py-2.5 px-4 text-muted-foreground">{durationLabel(a.checkInAt, a.checkOutAt)}</td>
                      <td className="py-2.5 px-4 text-muted-foreground">{a.checkedInByName || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
