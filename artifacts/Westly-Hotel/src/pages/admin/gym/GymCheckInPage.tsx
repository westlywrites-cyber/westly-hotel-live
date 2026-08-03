import { useState, useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useCollection } from "@/hooks/useFirebase";
import { where } from "firebase/firestore";
import { checkInGymMember, checkOutGymMember, effectiveMemberStatus, GYM_STATUS_COLORS } from "@/lib/gym";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { LogIn, LogOut, Search, Loader2, Users, Dumbbell } from "lucide-react";
import { DataError } from "@/components/ui/data-error";

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export default function GymCheckInPage() {
  const { adminUser, role } = useAuth();
  const { toast } = useToast();
  const { data: members, loading: membersLoading, error: membersError } = useCollection<any>("gym_members", [where("isDeleted", "!=", true)]);
  const { data: attendance, loading: attLoading, error: attError } = useCollection<any>("gym_attendance", [where("isDeleted", "!=", true)]);

  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const currentlyIn = useMemo(
    () => attendance.filter((a) => !a.checkOutAt).sort((a, b) => (b.checkInAt?.seconds || 0) - (a.checkInAt?.seconds || 0)),
    [attendance]
  );
  const today = todayKey();
  const todaysVisits = useMemo(
    () => attendance.filter((a) => a.dateKey === today).sort((a, b) => (b.checkInAt?.seconds || 0) - (a.checkInAt?.seconds || 0)),
    [attendance, today]
  );

  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    return members
      .filter((m) => m.name?.toLowerCase().includes(q) || m.phone?.includes(search) || m.roomNumber?.includes(search))
      .slice(0, 8);
  }, [members, search]);

  const openVisitByMember = useMemo(() => {
    const map: Record<string, any> = {};
    for (const a of currentlyIn) map[a.memberId] = a;
    return map;
  }, [currentlyIn]);

  if (!adminUser) return null;
  const actor = { id: adminUser.id, name: adminUser.name, role };

  async function handleCheckIn(member: any) {
    setBusyId(member.id);
    try {
      await checkInGymMember(member.id, member.name, actor);
      toast({ title: "Checked In", description: `${member.name} is now in the gym.` });
      setSearch("");
    } catch (err: any) {
      toast({ title: "Check-In Failed", description: err.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function handleCheckOut(visit: any) {
    setBusyId(visit.id);
    try {
      await checkOutGymMember(visit.id, visit.memberName, actor);
      toast({ title: "Checked Out", description: `${visit.memberName} has left the gym.` });
    } catch (err: any) {
      toast({ title: "Check-Out Failed", description: err.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-bold flex items-center gap-2"><Dumbbell className="w-6 h-6" /> Gym Check-In / Check-Out</h1>
        <p className="text-muted-foreground text-sm">Search for a member to check them in, or check out someone currently in the gym.</p>
      </div>

      {(membersError || attError) && <DataError message="We couldn't load gym data. Please check your connection." />}

      {/* Search + check-in */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search member by name, phone, or room…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {search.trim() && (
            <div className="space-y-1.5">
              {membersLoading ? (
                <p className="text-sm text-muted-foreground px-1">Searching…</p>
              ) : searchResults.length === 0 ? (
                <p className="text-sm text-muted-foreground px-1">No members found. Register them from the Members page.</p>
              ) : (
                searchResults.map((m) => {
                  const status = effectiveMemberStatus(m);
                  const alreadyIn = !!openVisitByMember[m.id];
                  return (
                    <div key={m.id} className="flex items-center justify-between gap-3 p-2.5 rounded-lg border border-border">
                      <div>
                        <p className="font-medium text-sm">{m.name}</p>
                        <p className="text-xs text-muted-foreground flex items-center gap-2">
                          {m.packageName || "—"}
                          <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${GYM_STATUS_COLORS[status]}`}>{status}</span>
                        </p>
                      </div>
                      {alreadyIn ? (
                        <span className="text-xs text-muted-foreground">Already checked in</span>
                      ) : (
                        <Button
                          size="sm"
                          className="gap-1.5"
                          disabled={status !== "active" || busyId === m.id}
                          onClick={() => handleCheckIn(m)}
                        >
                          {busyId === m.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />}
                          Check In
                        </Button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Currently in the gym — live */}
      <div>
        <h2 className="font-semibold text-sm mb-2 flex items-center gap-1.5"><Users className="w-4 h-4" /> Currently In the Gym ({currentlyIn.length})</h2>
        {attLoading ? (
          <div className="flex items-center justify-center h-24"><div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>
        ) : currentlyIn.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">Nobody is currently checked in.</CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {currentlyIn.map((v) => (
              <Card key={v.id}>
                <CardContent className="p-3.5 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{v.memberName}</p>
                    <p className="text-xs text-muted-foreground">
                      In since {v.checkInAt?.toDate ? v.checkInAt.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" className="gap-1.5 shrink-0" disabled={busyId === v.id} onClick={() => handleCheckOut(v)}>
                    {busyId === v.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
                    Check Out
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Today's visitor log */}
      <div>
        <h2 className="font-semibold text-sm mb-2">Today's Visitor Log ({todaysVisits.length})</h2>
        {todaysVisits.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">No visits recorded yet today.</CardContent></Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="text-left py-2.5 px-4 font-medium text-muted-foreground">Member</th>
                      <th className="text-left py-2.5 px-4 font-medium text-muted-foreground">Check-In</th>
                      <th className="text-left py-2.5 px-4 font-medium text-muted-foreground">Check-Out</th>
                      <th className="text-left py-2.5 px-4 font-medium text-muted-foreground">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {todaysVisits.map((v) => (
                      <tr key={v.id} className="border-b border-border last:border-0">
                        <td className="py-2.5 px-4 font-medium">{v.memberName}</td>
                        <td className="py-2.5 px-4 text-muted-foreground">{v.checkInAt?.toDate ? v.checkInAt.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                        <td className="py-2.5 px-4 text-muted-foreground">{v.checkOutAt?.toDate ? v.checkOutAt.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                        <td className="py-2.5 px-4 text-muted-foreground">{v.checkedInByName || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
