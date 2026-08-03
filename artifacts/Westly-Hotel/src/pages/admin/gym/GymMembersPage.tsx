import { useState, useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useCollection, useDocument } from "@/hooks/useFirebase";
import { where } from "firebase/firestore";
import {
  registerGymMember, renewGymMembership, setGymMembershipStatus, updateGymMemberDetails,
  softDeleteGymMember, effectiveMemberStatus, daysUntilExpiry, GYM_STATUS_COLORS,
  type GymMembershipStatus,
} from "@/lib/gym";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Dumbbell, Plus, Search, Loader2, RotateCw, Ban, CheckCircle2, Pencil, Trash2 } from "lucide-react";
import { formatDate, toFirestoreDate, asArray } from "@/lib/utils";
import { DataError } from "@/components/ui/data-error";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const STATUS_FILTERS: (GymMembershipStatus | "all")[] = ["all", "active", "expired", "suspended", "cancelled"];

export default function GymMembersPage() {
  const { adminUser, role } = useAuth();
  const { toast } = useToast();
  const { data: members, loading, error } = useCollection<any>("gym_members", [where("isDeleted", "!=", true)]);
  const { data: gymDoc } = useDocument("cms_content", "gym");
  const packages = asArray<any>((gymDoc as any)?.data?.packages);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<(GymMembershipStatus | "all")>("all");
  const [showRegister, setShowRegister] = useState(false);
  const [renewTarget, setRenewTarget] = useState<any | null>(null);
  const [editTarget, setEditTarget] = useState<any | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<any | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [saving, setSaving] = useState(false);

  const filtered = useMemo(() => {
    return members
      .map((m) => ({ ...m, effectiveStatus: effectiveMemberStatus(m) }))
      .filter((m) => statusFilter === "all" || m.effectiveStatus === statusFilter)
      .filter((m) => !search || m.name?.toLowerCase().includes(search.toLowerCase()) || m.phone?.includes(search) || m.roomNumber?.includes(search))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [members, statusFilter, search]);

  if (!adminUser) return null;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif text-2xl font-bold flex items-center gap-2"><Dumbbell className="w-6 h-6" /> Gym Members</h1>
          <p className="text-muted-foreground text-sm">{members.length} total members</p>
        </div>
        <Button className="gap-2" onClick={() => setShowRegister(true)}><Plus className="w-4 h-4" /> Register Member</Button>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search by name, phone, or room…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>{STATUS_FILTERS.map((s) => <SelectItem key={s} value={s}>{s === "all" ? "All Statuses" : s[0].toUpperCase() + s.slice(1)}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>
      ) : error ? (
        <DataError message="We couldn't load gym members." />
      ) : filtered.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground text-sm">No members match your search.</CardContent></Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Member</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Package</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Status</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Expires</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Visits</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m) => {
                    const daysLeft = daysUntilExpiry(m.endDate);
                    return (
                      <tr key={m.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                        <td className="py-3 px-4">
                          <p className="font-medium">{m.name}</p>
                          <p className="text-xs text-muted-foreground">{m.phone || m.email || (m.roomNumber ? `Room ${m.roomNumber}` : "—")}</p>
                        </td>
                        <td className="py-3 px-4 text-sm">{m.packageName || "—"}</td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${GYM_STATUS_COLORS[m.effectiveStatus as GymMembershipStatus]}`}>{m.effectiveStatus}</span>
                        </td>
                        <td className="py-3 px-4 text-xs text-muted-foreground">
                          {formatDate(toFirestoreDate(m.endDate))}
                          {m.effectiveStatus === "active" && daysLeft !== null && daysLeft <= 7 && (
                            <span className="block text-orange-600 font-medium">{daysLeft <= 0 ? "expires today" : `${daysLeft}d left`}</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-sm">{m.visitCount || 0}</td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-1 flex-wrap">
                            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => setRenewTarget(m)}><RotateCw className="w-3 h-3" />Renew</Button>
                            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => setEditTarget(m)}><Pencil className="w-3 h-3" />Edit</Button>
                            {m.status === "suspended" ? (
                              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-green-600" onClick={async () => { await setGymMembershipStatus(m.id, "active", { id: adminUser.id, name: adminUser.name, role }); toast({ title: "Membership Reactivated" }); }}><CheckCircle2 className="w-3 h-3" />Reactivate</Button>
                            ) : (
                              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-orange-600" onClick={() => setSuspendTarget(m)}><Ban className="w-3 h-3" />Suspend</Button>
                            )}
                            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-destructive" onClick={() => setDeleteTarget(m)}><Trash2 className="w-3 h-3" />Remove</Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Register dialog */}
      <RegisterDialog open={showRegister} onOpenChange={setShowRegister} packages={packages} actor={{ id: adminUser.id, name: adminUser.name, role }} />

      {/* Renew dialog */}
      <RenewDialog target={renewTarget} onOpenChange={(o) => !o && setRenewTarget(null)} packages={packages} actor={{ id: adminUser.id, name: adminUser.name, role }} />

      {/* Edit dialog */}
      <EditDialog target={editTarget} onOpenChange={(o) => !o && setEditTarget(null)} actor={{ id: adminUser.id, name: adminUser.name, role }} />

      {/* Suspend confirm */}
      <AlertDialog open={!!suspendTarget} onOpenChange={(o) => !o && setSuspendTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend {suspendTarget?.name}'s membership?</AlertDialogTitle>
            <AlertDialogDescription>They won't be able to check in until reactivated.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={async () => {
                if (!suspendTarget) return;
                setSaving(true);
                try {
                  await setGymMembershipStatus(suspendTarget.id, "suspended", { id: adminUser.id, name: adminUser.name, role });
                  toast({ title: "Membership Suspended" });
                } catch (err: any) {
                  toast({ title: "Failed", description: err.message, variant: "destructive" });
                } finally {
                  setSaving(false);
                  setSuspendTarget(null);
                }
              }}
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Suspend"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>This removes them from the active members list. Their attendance history is kept for reporting.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteTarget) return;
                await softDeleteGymMember(deleteTarget.id, { id: adminUser.id, name: adminUser.name, role });
                toast({ title: "Member Removed" });
                setDeleteTarget(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RegisterDialog({ open, onOpenChange, packages, actor }: { open: boolean; onOpenChange: (o: boolean) => void; packages: any[]; actor: { id: string; name: string; role: string | null } }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", roomNumber: "", packageId: "", customDuration: 30, customPrice: 0, customName: "", notes: "" });

  const selectedPkg = packages.find((p) => p.id === form.packageId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const packageName = selectedPkg ? selectedPkg.name : form.customName || "Custom Membership";
      const packagePrice = selectedPkg ? Number(selectedPkg.price || 0) : Number(form.customPrice || 0);
      const durationDays = selectedPkg ? durationToDays(selectedPkg.duration) : Number(form.customDuration || 30);

      await registerGymMember({
        name: form.name,
        email: form.email || null,
        phone: form.phone || null,
        roomNumber: form.roomNumber || null,
        packageId: form.packageId || "custom",
        packageName,
        packagePrice,
        durationDays,
        notes: form.notes || null,
        actor,
      });
      toast({ title: "Member Registered", description: `${form.name} is now an active gym member.` });
      setForm({ name: "", email: "", phone: "", roomNumber: "", packageId: "", customDuration: 30, customPrice: 0, customName: "", notes: "" });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "Registration Failed", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Register New Gym Member</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 col-span-2"><Label>Full Name *</Label><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Phone</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div className="space-y-1.5 col-span-2"><Label>Room Number (if a current hotel guest)</Label><Input value={form.roomNumber} onChange={(e) => setForm({ ...form, roomNumber: e.target.value })} placeholder="Optional" /></div>
            <div className="space-y-1.5 col-span-2">
              <Label>Membership Package</Label>
              <Select value={form.packageId} onValueChange={(v) => setForm({ ...form, packageId: v })}>
                <SelectTrigger><SelectValue placeholder="Select a package…" /></SelectTrigger>
                <SelectContent>
                  {packages.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} — ${Number(p.price || 0).toFixed(0)} ({p.duration})</SelectItem>)}
                  <SelectItem value="">Custom…</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {!selectedPkg && (
              <>
                <div className="space-y-1.5 col-span-2"><Label>Custom Package Name</Label><Input value={form.customName} onChange={(e) => setForm({ ...form, customName: e.target.value })} placeholder="e.g. Weekly Pass" /></div>
                <div className="space-y-1.5"><Label>Duration (days)</Label><Input type="number" min={1} value={form.customDuration} onChange={(e) => setForm({ ...form, customDuration: Number(e.target.value) || 1 })} /></div>
                <div className="space-y-1.5"><Label>Price (USD)</Label><Input type="number" min={0} value={form.customPrice} onChange={(e) => setForm({ ...form, customPrice: Number(e.target.value) || 0 })} /></div>
              </>
            )}
            <div className="space-y-1.5 col-span-2"><Label>Notes</Label><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving} className="gap-2">{saving && <Loader2 className="w-4 h-4 animate-spin" />}Register Member</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenewDialog({ target, onOpenChange, packages, actor }: { target: any | null; onOpenChange: (o: boolean) => void; packages: any[]; actor: { id: string; name: string; role: string | null } }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [packageId, setPackageId] = useState("");

  if (!target) return null;
  const selectedPkg = packages.find((p) => p.id === packageId) || packages.find((p) => p.id === target.packageId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPkg) { toast({ title: "Select a package", variant: "destructive" }); return; }
    setSaving(true);
    try {
      await renewGymMembership({
        memberId: target.id,
        packageId: selectedPkg.id,
        packageName: selectedPkg.name,
        packagePrice: Number(selectedPkg.price || 0),
        durationDays: durationToDays(selectedPkg.duration),
        actor,
      });
      toast({ title: "Membership Renewed", description: `${target.name}'s membership has been extended.` });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "Renewal Failed", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Renew — {target.name}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Package</Label>
            <Select value={packageId || target.packageId} onValueChange={setPackageId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{packages.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} — ${Number(p.price || 0).toFixed(0)} ({p.duration})</SelectItem>)}</SelectContent>
            </Select>
            {packages.length === 0 && <p className="text-xs text-muted-foreground">No packages configured yet — add one under Gym Management → Membership Packages.</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || packages.length === 0} className="gap-2">{saving && <Loader2 className="w-4 h-4 animate-spin" />}Renew</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ target, onOpenChange, actor }: { target: any | null; onOpenChange: (o: boolean) => void; actor: { id: string; name: string; role: string | null } }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", roomNumber: "", notes: "" });

  useMemo(() => {
    if (target) setForm({ name: target.name || "", email: target.email || "", phone: target.phone || "", roomNumber: target.roomNumber || "", notes: target.notes || "" });
  }, [target?.id]);

  if (!target) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await updateGymMemberDetails(target.id, { name: form.name, email: form.email || null, phone: form.phone || null, roomNumber: form.roomNumber || null, notes: form.notes || null }, actor);
      toast({ title: "Member Updated" });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "Update Failed", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Edit Member</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5"><Label>Name *</Label><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Phone</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Email</Label><Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          </div>
          <div className="space-y-1.5"><Label>Room Number</Label><Input value={form.roomNumber} onChange={(e) => setForm({ ...form, roomNumber: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>Notes</Label><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving} className="gap-2">{saving && <Loader2 className="w-4 h-4 animate-spin" />}Save Changes</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function durationToDays(label: string): number {
  const l = (label || "").toLowerCase();
  if (l.includes("year") || l.includes("annual")) return 365;
  if (l.includes("quarter")) return 90;
  if (l.includes("week")) return 7;
  if (l.includes("day")) return 1;
  return 30; // default: monthly
}
