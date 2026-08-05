import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useCollection, useDocumentsByIds } from "@/hooks/useFirebase";
import { where, orderBy, limit } from "firebase/firestore";
import {
  completeHousekeepingTask, startHousekeepingTask, createManualHousekeepingTask,
  HOUSEKEEPING_PRIORITY_COLORS, HOUSEKEEPING_TASK_TYPE_LABELS,
  type HousekeepingTaskType,
} from "@/lib/housekeeping";
import { updateRoomStatus } from "@/lib/roomLogic";
import { logAction } from "@/lib/audit";
import { notifyMaintenanceRequest } from "@/lib/notifications";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { usePinTaskComplete } from "@/hooks/usePinTaskComplete";
import {
  Sparkles, CheckCircle, BedDouble, Clock, AlertTriangle, Loader2,
  History, ChevronDown, ClipboardList, Users, PlayCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DataError } from "@/components/ui/data-error";
import { PinSessionEndingOverlay } from "@/components/admin/PinSessionEndingOverlay";

function fmtWhen(v: any): string {
  if (!v) return "—";
  const d = v?.toDate ? v.toDate() : new Date(v);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ══════════════════════════════════════════════════════════════════════════
// Per-room cleaning history — lazily loaded only when expanded, scoped by
// the security rules to rooms the current housekeeper actually owns.
// ══════════════════════════════════════════════════════════════════════════
function RoomHistory({ roomId }: { roomId: string }) {
  const [open, setOpen] = useState(false);
  const { data: history, loading } = useCollection<any>(
    "housekeeping_tasks",
    [
      where("roomId", "==", open ? roomId : "__collapsed__"),
      where("status", "==", "completed"),
      orderBy("completedAt", "desc"),
      limit(5),
    ],
    // Explicit depsKey: the constraint list has the same shape (where/where/
    // orderBy/limit) whether collapsed or open, so useCollection's default
    // shape-only key never changed and this panel kept listening to the
    // "__collapsed__" placeholder query forever, even after being expanded.
    `${roomId}:${open}`
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <History className="h-3.5 w-3.5" /> Cleaning history
          <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-1.5">
        {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {!loading && history.length === 0 && <p className="text-xs text-muted-foreground">No completed tasks logged yet.</p>}
        {history.map((h: any) => (
          <div key={h.id} className="text-xs flex items-center justify-between bg-muted/40 rounded px-2 py-1.5">
            <span>{HOUSEKEEPING_TASK_TYPE_LABELS[h.type as HousekeepingTaskType] || h.type}</span>
            <span className="text-muted-foreground">{fmtWhen(h.completedAt)} · {h.completedByName}</span>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// HOUSEKEEPER VIEW (Requirement 1) — only their own queue, their own
// assigned rooms, and history scoped to those rooms. Enforced both here
// (queries filter by assignedTo/housekeeperId == me) and in firestore.rules
// (a housekeeper literally cannot read another housekeeper's task/room).
// ══════════════════════════════════════════════════════════════════════════
function MyHousekeepingDashboard() {
  const { adminUser, role } = useAuth();
  const { toast } = useToast();
  const { isPinSession, endingSession, notifyTaskComplete } = usePinTaskComplete();
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: queue, loading: queueLoading, error: queueError, refetch: refetchQueue } = useCollection<any>(
    "housekeeping_tasks",
    adminUser ? [where("assignedTo", "==", adminUser.id), where("status", "in", ["pending", "in_progress"]), orderBy("scheduledFor", "asc")] : []
  );
  const { data: assignments, loading: roomsLoading, error: roomsError, refetch: refetchRooms } = useCollection<any>(
    "room_assignments",
    adminUser ? [where("housekeeperId", "==", adminUser.id), where("status", "==", "active")] : []
  );
  // Only fetch the rooms actually assigned to this housekeeper (Requirement 1)
  // — not the full hotel-wide rooms collection, which this page used to pull
  // in just to read type/floor for the "My Rooms" tab.
  const assignedRoomIds = assignments.map((a: any) => a.roomId);
  const { data: assignedRooms } = useDocumentsByIds<any>("rooms", assignedRoomIds);

  const priorityRank: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
  const sortedQueue = [...queue].sort((a, b) => (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9));

  const roomById = new Map(assignedRooms.map((r: any) => [r.id, r]));

  const handleStart = async (task: any) => {
    if (!adminUser) return;
    setBusyId(task.id);
    try {
      await startHousekeepingTask(task.id, { id: adminUser.id, name: adminUser.name, role });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const handleComplete = async (task: any) => {
    if (!adminUser) return;
    setBusyId(task.id);
    try {
      await completeHousekeepingTask(
        task.id,
        { id: task.roomId, number: task.roomNumber, type: task.type },
        { id: adminUser.id, name: adminUser.name, role }
      );
      toast({ title: "Task Complete", description: `Room ${task.roomNumber} marked done.` });
      notifyTaskComplete();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const handleQuickClean = async (roomId: string, roomNumber: string) => {
    if (!adminUser) return;
    setBusyId(roomId);
    try {
      const taskId = await createManualHousekeepingTask({
        roomId, roomNumber, type: "cleaning", priority: "medium",
        assignedTo: adminUser.id, assignedToName: adminUser.name,
        actor: { id: adminUser.id, name: adminUser.name, role },
      });
      await completeHousekeepingTask(taskId, { id: roomId, number: roomNumber, type: "cleaning" }, { id: adminUser.id, name: adminUser.name, role });
      toast({ title: "Room Marked Clean", description: `Room ${roomNumber} is now available.` });
      notifyTaskComplete();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const handleMaintenance = async (roomId: string, roomNumber: string) => {
    if (!adminUser) return;
    setBusyId(roomId);
    try {
      await updateRoomStatus(roomId, "maintenance");
      await logAction(adminUser.id, adminUser.name, "room_maintenance", "rooms", roomId, null, { status: "maintenance" }, role ?? undefined);
      toast({ title: "Room Sent to Maintenance", description: `Room ${roomNumber} flagged for maintenance.` });
      notifyMaintenanceRequest(`Room ${roomNumber}`, "Flagged by housekeeping", adminUser.name).catch(() => {});
      notifyTaskComplete();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const error = queueError || roomsError;
  if (error) {
    return (
      <DataError
        message="We couldn't load your housekeeping dashboard."
        detail={`${(queueError as any)?.code || (roomsError as any)?.code || ""} ${error.message || ""}`.trim()}
        onRetry={() => { refetchQueue(); refetchRooms(); }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <PinSessionEndingOverlay visible={isPinSession && endingSession} />
      <div>
        <h1 className="font-serif text-2xl font-bold">My Housekeeping</h1>
        <p className="text-muted-foreground text-sm">
          {sortedQueue.length} task{sortedQueue.length !== 1 ? "s" : ""} in your queue · {assignments.length} room{assignments.length !== 1 ? "s" : ""} assigned to you
        </p>
      </div>

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue" className="gap-1.5"><ClipboardList className="h-3.5 w-3.5" /> My Queue ({sortedQueue.length})</TabsTrigger>
          <TabsTrigger value="rooms" className="gap-1.5"><BedDouble className="h-3.5 w-3.5" /> My Rooms ({assignments.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="mt-4">
          {queueLoading ? (
            <div className="flex items-center justify-center h-32">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : sortedQueue.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
                <CheckCircle className="w-8 h-8 text-green-600" />
              </div>
              <h3 className="font-semibold text-lg">Your queue is empty!</h3>
              <p className="text-muted-foreground text-sm mt-1">Nothing pending right now.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {sortedQueue.map((task: any) => (
                <Card key={task.id} className="border-yellow-200 dark:border-yellow-800">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-bold text-lg">Room {task.roomNumber}</h3>
                        <p className="text-xs text-muted-foreground">{HOUSEKEEPING_TASK_TYPE_LABELS[task.type as HousekeepingTaskType] || task.type}</p>
                      </div>
                      <Badge className={cn("text-[11px]", HOUSEKEEPING_PRIORITY_COLORS[task.priority as keyof typeof HOUSEKEEPING_PRIORITY_COLORS])}>
                        {task.priority}
                      </Badge>
                    </div>
                    {task.instructions && (
                      <p className="text-xs bg-muted/50 rounded px-2 py-1.5 italic">"{task.instructions}"</p>
                    )}
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" /> Scheduled {fmtWhen(task.scheduledFor)}
                      {task.status === "in_progress" && <Badge variant="secondary" className="text-[10px] ml-1">In Progress</Badge>}
                    </p>
                    <div className="flex gap-2">
                      {task.status === "pending" && (
                        <Button size="sm" variant="outline" className="flex-1 gap-1.5" onClick={() => handleStart(task)} disabled={busyId === task.id}>
                          <PlayCircle className="w-3.5 h-3.5" /> Start
                        </Button>
                      )}
                      <Button
                        size="sm"
                        className="flex-1 gap-2 bg-green-600 hover:bg-green-700 text-white"
                        onClick={() => handleComplete(task)}
                        disabled={busyId === task.id}
                      >
                        {busyId === task.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                        Complete
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="rooms" className="mt-4">
          {roomsLoading ? (
            <div className="flex items-center justify-center h-32">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : assignments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground text-sm">
              No rooms are assigned to you yet. Ask your Operations Manager to set up a room assignment.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {assignments.map((a: any) => {
                const room = roomById.get(a.roomId);
                const pendingTask = queue.find((t: any) => t.roomId === a.roomId);
                return (
                  <Card key={a.roomId}>
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <h3 className="font-bold text-lg">Room {a.roomNumber}</h3>
                          <p className="text-xs text-muted-foreground">{room?.type || ""} {room?.floor ? `· Floor ${room.floor}` : ""}</p>
                        </div>
                        {room?.status && (
                          <Badge variant="outline" className="text-[11px] capitalize">{room.status}</Badge>
                        )}
                      </div>
                      {pendingTask && (
                        <Badge className={cn("text-[10px]", HOUSEKEEPING_PRIORITY_COLORS[pendingTask.priority as keyof typeof HOUSEKEEPING_PRIORITY_COLORS])}>
                          {pendingTask.priority} priority task pending
                        </Badge>
                      )}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          className="flex-1 gap-2 bg-green-600 hover:bg-green-700 text-white"
                          onClick={() => handleQuickClean(a.roomId, a.roomNumber)}
                          disabled={busyId === a.roomId}
                        >
                          {busyId === a.roomId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                          Mark Clean
                        </Button>
                        <Button
                          size="sm" variant="outline"
                          className="gap-1 border-orange-400 text-orange-600 hover:bg-orange-50"
                          onClick={() => handleMaintenance(a.roomId, a.roomNumber)}
                          disabled={busyId === a.roomId}
                        >
                          <AlertTriangle className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      <RoomHistory roomId={a.roomId} />
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// MANAGEMENT / OPERATIONS MANAGER OVERVIEW — cross-team visibility, plus
// surfacing any auto-generated tasks the scheduler couldn't assign (no
// active room assignment existed yet) so they get picked up by a human.
// ══════════════════════════════════════════════════════════════════════════
function HousekeepingOverview() {
  const { adminUser, role } = useAuth();
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [runningQueue, setRunningQueue] = useState(false);
  const { data: rooms, loading, error, refetch } = useCollection<any>("rooms", [where("isDeleted", "!=", true)]);
  const { data: unassigned } = useCollection<any>(
    "housekeeping_tasks",
    [where("assignedTo", "==", null), where("status", "==", "pending")]
  );

  const runQueueNow = async () => {
    const { auth } = await import("@/lib/firebase");
    if (!auth.currentUser) return;
    setRunningQueue(true);
    try {
      const idToken = await auth.currentUser.getIdToken();
      const res = await fetch("/api/housekeeping-queue-run-now", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result?.error || "Failed to run queue generator.");
      toast({
        title: "Queue Updated",
        description: `${result.checkoutTasksCreated} checkout + ${result.occupiedServiceTasksCreated} occupied-service task(s) created.`,
      });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setRunningQueue(false);
    }
  };


  const cleaningRooms = rooms.filter((r: any) => r.status === "cleaning");

  const markClean = async (room: any) => {
    if (!adminUser) return;
    setBusyId(room.id);
    try {
      await createManualHousekeepingTaskAndComplete(room, adminUser, role);
      toast({ title: "Room Marked Clean", description: `Room ${room.number} is now available.` });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  async function createManualHousekeepingTaskAndComplete(room: any, adminUser: any, role: any) {
    const taskId = await createManualHousekeepingTask({
      roomId: room.id, roomNumber: room.number, type: "cleaning", priority: "medium",
      assignedTo: adminUser.id, assignedToName: adminUser.name,
      actor: { id: adminUser.id, name: adminUser.name, role },
    });
    await completeHousekeepingTask(taskId, { id: room.id, number: room.number, type: "cleaning" }, { id: adminUser.id, name: adminUser.name, role });
  }

  const markMaintenance = async (room: any) => {
    if (!adminUser) return;
    setBusyId(room.id);
    try {
      await updateRoomStatus(room.id, "maintenance");
      await logAction(adminUser.id, adminUser.name, "room_maintenance", "rooms", room.id, { status: room.status }, { status: "maintenance" }, role ?? undefined);
      toast({ title: "Room Sent to Maintenance", description: `Room ${room.number} flagged for maintenance.` });
      notifyMaintenanceRequest(`Room ${room.number}`, "Flagged by housekeeping", adminUser.name).catch(() => {});
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  if (error) return <DataError message="We couldn't load room status." detail={`${(error as any)?.code || ""} ${error.message || ""}`.trim()} onRetry={refetch} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif text-2xl font-bold">Housekeeping Overview</h1>
          <p className="text-muted-foreground text-sm">{cleaningRooms.length} room{cleaningRooms.length !== 1 ? "s" : ""} need cleaning today across all housekeepers</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="gap-1.5" onClick={runQueueNow} disabled={runningQueue}>
            {runningQueue ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
            Run Queue Now
          </Button>
          <Link href="/admin/housekeeping/assignments">
            <Button variant="outline" className="gap-1.5"><Users className="h-4 w-4" /> Room Assignments</Button>
          </Link>
        </div>
      </div>

      {unassigned.length > 0 && (
        <Card className="border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-900/10">
          <CardContent className="p-4 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-red-600" />
              <span><strong>{unassigned.length}</strong> auto-generated task{unassigned.length !== 1 ? "s" : ""} have no assigned housekeeper yet (no active room assignment found).</span>
            </div>
            <Link href="/admin/housekeeping/assignments">
              <Button size="sm" variant="destructive">Assign Now</Button>
            </Link>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: "Needs Cleaning", value: rooms.filter((r: any) => r.status === "cleaning").length, color: "text-yellow-600", bg: "bg-yellow-50 dark:bg-yellow-900/10" },
          { label: "Maintenance", value: rooms.filter((r: any) => r.status === "maintenance").length, color: "text-orange-600", bg: "bg-orange-50 dark:bg-orange-900/10" },
          { label: "Available", value: rooms.filter((r: any) => r.status === "available").length, color: "text-green-600", bg: "bg-green-50 dark:bg-green-900/10" },
        ].map(s => (
          <Card key={s.label}>
            <CardContent className={`p-4 ${s.bg}`}>
              <p className={`text-3xl font-bold ${s.color}`}>{s.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : cleaningRooms.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
            <CheckCircle className="w-8 h-8 text-green-600" />
          </div>
          <h3 className="font-semibold text-lg">All rooms are clean!</h3>
          <p className="text-muted-foreground text-sm mt-1">No rooms currently need cleaning.</p>
        </div>
      ) : (
        <div>
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            <Clock className="w-4 h-4 text-yellow-500" /> Rooms Awaiting Cleaning
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {cleaningRooms.map((room: any) => (
              <Card key={room.id} className="border-yellow-200 dark:border-yellow-800">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-bold text-lg">Room {room.number}</h3>
                      <p className="text-xs text-muted-foreground">{room.type} · Floor {room.floor}</p>
                    </div>
                    <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400 text-[11px]">
                      Cleaning
                    </Badge>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1 gap-2 bg-green-600 hover:bg-green-700 text-white"
                      onClick={() => markClean(room)}
                      disabled={busyId === room.id}
                    >
                      {busyId === room.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                      {busyId === room.id ? "Updating…" : "Mark Clean"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1 border-orange-400 text-orange-600 hover:bg-orange-50"
                      onClick={() => markMaintenance(room)}
                      disabled={busyId === room.id}
                    >
                      <AlertTriangle className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function HousekeepingPage() {
  const { role } = useAuth();
  return role === "housekeeping" ? <MyHousekeepingDashboard /> : <HousekeepingOverview />;
}