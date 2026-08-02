import { useState, useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useCollection } from "@/hooks/useFirebase";
import { orderBy } from "firebase/firestore";
import { endRoomAssignmentGroup, updateRoomAssignmentGroup } from "@/lib/housekeeping";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Users, Plus, Pencil, XCircle, ArrowRightLeft, Loader2, BedDouble } from "lucide-react";
import { DataError } from "@/components/ui/data-error";
import RoomAssignDialog from "@/components/admin/RoomAssignDialog";
import { cn } from "@/lib/utils";

function fmtDate(v: any): string {
  if (!v) return "—";
  const d = v?.toDate ? v.toDate() : new Date(v);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function toDateInputValue(v: any): string {
  if (!v) return "";
  const d = v?.toDate ? v.toDate() : new Date(v);
  return d.toISOString().slice(0, 10);
}

export default function RoomAssignmentsPage() {
  const { adminUser, role } = useAuth();
  const { toast } = useToast();
  const { data: groups, loading, error } = useCollection<any>("room_assignment_groups", [orderBy("createdAt", "desc")]);

  const [showAssign, setShowAssign] = useState(false);
  const [reassignGroup, setReassignGroup] = useState<any>(null);
  const [editGroup, setEditGroup] = useState<any>(null);
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [editHasEnd, setEditHasEnd] = useState(true);
  const [editNotes, setEditNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [endTarget, setEndTarget] = useState<any>(null);
  const [ending, setEnding] = useState(false);
  const [tab, setTab] = useState<"active" | "ended">("active");

  const filtered = useMemo(
    () => groups.filter((g: any) => (tab === "active" ? g.status === "active" : g.status === "ended")),
    [groups, tab]
  );

  const openEdit = (g: any) => {
    setEditGroup(g);
    setEditStart(toDateInputValue(g.startDate));
    setEditHasEnd(!!g.endDate);
    setEditEnd(g.endDate ? toDateInputValue(g.endDate) : toDateInputValue(new Date()));
    setEditNotes(g.notes || "");
  };

  const handleSaveEdit = async () => {
    if (!adminUser || !editGroup) return;
    setSaving(true);
    try {
      await updateRoomAssignmentGroup(editGroup.id, {
        startDate: new Date(`${editStart}T00:00:00Z`),
        endDate: editHasEnd && editEnd ? new Date(`${editEnd}T00:00:00Z`) : null,
        notes: editNotes,
      }, { id: adminUser.id, name: adminUser.name, role });
      toast({ title: "Assignment updated" });
      setEditGroup(null);
    } catch (err: any) {
      toast({ title: "Failed to update", description: err?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleEnd = async () => {
    if (!adminUser || !endTarget) return;
    setEnding(true);
    try {
      await endRoomAssignmentGroup(endTarget.id, { id: adminUser.id, name: adminUser.name, role });
      toast({ title: "Assignment ended", description: `${endTarget.housekeeperName}'s rooms are now unassigned.` });
      setEndTarget(null);
    } catch (err: any) {
      toast({ title: "Failed to end assignment", description: err?.message, variant: "destructive" });
    } finally {
      setEnding(false);
    }
  };

  if (error) return <DataError message="We couldn't load room assignments." />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Users className="h-6 w-6" /> Room Assignments</h1>
          <p className="text-muted-foreground text-sm">
            Give housekeepers long-term ownership of specific rooms — e.g. an entire floor for a month.
          </p>
        </div>
        <Button onClick={() => setShowAssign(true)}><Plus className="h-4 w-4 mr-1.5" /> Assign Rooms</Button>
      </div>

      <div className="flex gap-2">
        <Button size="sm" variant={tab === "active" ? "default" : "outline"} onClick={() => setTab("active")}>
          Active ({groups.filter((g: any) => g.status === "active").length})
        </Button>
        <Button size="sm" variant={tab === "ended" ? "default" : "outline"} onClick={() => setTab("ended")}>
          Ended ({groups.filter((g: any) => g.status === "ended").length})
        </Button>
      </div>

      <div className="grid gap-3">
        {loading && <p className="text-sm text-muted-foreground">Loading assignments…</p>}
        {!loading && filtered.length === 0 && (
          <Card><CardContent className="py-10 text-center text-muted-foreground text-sm">
            No {tab} room assignments.
          </CardContent></Card>
        )}
        {filtered.map((g: any) => (
          <Card key={g.id} className={cn(g.status === "ended" && "opacity-70")}>
            <CardContent className="py-4 flex flex-col md:flex-row md:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">{g.housekeeperName}</span>
                  <Badge variant={g.status === "active" ? "default" : "secondary"} className="text-[10px]">{g.status}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {fmtDate(g.startDate)} {g.endDate ? `– ${fmtDate(g.endDate)}` : "· ongoing"}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                  <BedDouble className="h-3.5 w-3.5 text-muted-foreground" />
                  {(g.roomNumbers || []).slice(0, 12).map((n: string) => (
                    <Badge key={n} variant="outline" className="text-[10px]">Rm {n}</Badge>
                  ))}
                  {(g.roomNumbers || []).length > 12 && (
                    <span className="text-xs text-muted-foreground">+{g.roomNumbers.length - 12} more</span>
                  )}
                  {(g.roomNumbers || []).length === 0 && (
                    <span className="text-xs text-muted-foreground italic">No rooms remaining in this group</span>
                  )}
                </div>
                {g.notes && <p className="text-xs text-muted-foreground mt-1.5 italic">"{g.notes}"</p>}
              </div>
              {g.status === "active" && (
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" variant="outline" onClick={() => openEdit(g)}>
                    <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setReassignGroup(g)}>
                    <ArrowRightLeft className="h-3.5 w-3.5 mr-1" /> Reassign
                  </Button>
                  <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setEndTarget(g)}>
                    <XCircle className="h-3.5 w-3.5 mr-1" /> End
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <RoomAssignDialog open={showAssign} onOpenChange={setShowAssign} />

      {/* Reassign: same rooms, different housekeeper */}
      <RoomAssignDialog
        open={!!reassignGroup}
        onOpenChange={(v) => !v && setReassignGroup(null)}
        preselectedRoomIds={reassignGroup?.roomIds || []}
      />

      {/* Edit dates/notes on an existing group */}
      <Dialog open={!!editGroup} onOpenChange={(v) => !v && setEditGroup(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Edit Assignment — {editGroup?.housekeeperName}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Start Date</Label>
                <Input type="date" value={editStart} onChange={e => setEditStart(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>End Date</Label>
                  <button type="button" className="text-xs text-primary underline underline-offset-2" onClick={() => setEditHasEnd(v => !v)}>
                    {editHasEnd ? "Make ongoing" : "Set end date"}
                  </button>
                </div>
                <Input type="date" value={editEnd} onChange={e => setEditEnd(e.target.value)} disabled={!editHasEnd} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Special Instructions</Label>
              <Input value={editNotes} onChange={e => setEditNotes(e.target.value)} placeholder="Optional notes" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditGroup(null)} disabled={saving}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!endTarget} onOpenChange={(v) => !v && setEndTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End this assignment?</AlertDialogTitle>
            <AlertDialogDescription>
              {endTarget?.housekeeperName} will lose access to {(endTarget?.roomNumbers || []).length} room(s)
              immediately. They'll be unassigned until reassigned to someone else.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={ending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleEnd} disabled={ending} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {ending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} End Assignment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
