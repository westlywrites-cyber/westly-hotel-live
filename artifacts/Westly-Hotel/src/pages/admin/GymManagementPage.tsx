import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useDocument } from "@/hooks/useFirebase";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { logAction } from "@/lib/audit";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import ImageUpload from "@/components/admin/ImageUpload";
import { asArray } from "@/lib/utils";
import { DataError } from "@/components/ui/data-error";
import {
  Dumbbell, Info, ListChecks, Clock, Tag, Users2, Images, Plus, Pencil, Trash2,
  Loader2, CheckCircle, ArrowUp, ArrowDown, ImageOff, X, Star,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Tab = "about" | "equipment" | "hours" | "packages" | "programs" | "gallery";

interface EquipmentItem { id: string; name: string; image: string; description: string; icon: string; }
interface PackageItem { id: string; name: string; price: number; duration: string; features: string[]; popular: boolean; }
interface ProgramItem { id: string; name: string; description: string; image: string; }
interface HoursRow { day: string; open: string; close: string; closed: boolean; }

interface GymData {
  about: string;
  equipment: EquipmentItem[];
  hours: HoursRow[];
  packages: PackageItem[];
  programs: ProgramItem[];
  gallery: string[];
}

const DEFAULT_HOURS: HoursRow[] = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
].map(day => ({ day, open: "06:00", close: "22:00", closed: false }));

const EMPTY_DATA: GymData = { about: "", equipment: [], hours: DEFAULT_HOURS, packages: [], programs: [], gallery: [] };

const ICON_OPTIONS = ["Dumbbell", "Sparkles", "Waves", "Heart", "Users", "Trophy", "Timer", "Flame", "Zap"];
const MAX_LIST = 20;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export default function GymManagementPage() {
  const { adminUser, role } = useAuth();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("about");

  const { data: gymDoc, loading, error } = useDocument("cms_content", "gym");
  const [gym, setGym] = useState<GymData>(EMPTY_DATA);

  useEffect(() => {
    if (gymDoc) {
      const raw = ((gymDoc as any).data || {}) as Partial<GymData>;
      setGym({
        about: raw.about || "",
        equipment: asArray<EquipmentItem>(raw.equipment),
        hours: raw.hours && asArray<HoursRow>(raw.hours).length === 7 ? asArray<HoursRow>(raw.hours) : DEFAULT_HOURS,
        packages: asArray<PackageItem>(raw.packages),
        programs: asArray<ProgramItem>(raw.programs),
        gallery: asArray<string>(raw.gallery),
      });
    }
  }, [gymDoc]);

  async function persist(updated: GymData, successMsg: string) {
    if (!adminUser) return;
    if (error) {
      toast({ title: "Can't save yet", description: "Gym content failed to load, so saving now could overwrite it with incomplete data. Reload the page first.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await setDoc(doc(db, "cms_content", "gym"), { data: updated, updatedAt: serverTimestamp() }, { merge: true });
      setGym(updated);
      await logAction(adminUser.id, adminUser.name, "gym_content_updated", "cms_content", "gym", null, null, role ?? undefined);
      toast({ title: successMsg });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const TABS: { key: Tab; label: string; icon: React.ComponentType<any> }[] = [
    { key: "about", label: "About", icon: Info },
    { key: "equipment", label: "Equipment & Services", icon: ListChecks },
    { key: "hours", label: "Hours", icon: Clock },
    { key: "packages", label: "Membership Packages", icon: Tag },
    { key: "programs", label: "Programs", icon: Users2 },
    { key: "gallery", label: "Gallery", icon: Images },
  ];

  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <h1 className="font-serif text-2xl font-bold flex items-center gap-2">
          <Dumbbell className="w-6 h-6" /> Gym Management
        </h1>
        <p className="text-muted-foreground text-sm">
          Manage everything shown on the public Gym page — every change here goes live immediately.
          The hero banner is edited from Website CMS → Page Banners → Gym Page Hero Banner.
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading gym content…
        </div>
      )}
      {error && <DataError message="Gym content failed to load. Reload before adding or editing." />}

      <div className="flex gap-1.5 flex-wrap border-b border-border pb-2">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-t-lg text-sm font-medium transition-colors ${
              activeTab === tab.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "about" && <AboutTab gym={gym} saving={saving} persist={persist} />}
      {activeTab === "equipment" && <EquipmentTab gym={gym} saving={saving} persist={persist} />}
      {activeTab === "hours" && <HoursTab gym={gym} saving={saving} persist={persist} />}
      {activeTab === "packages" && <PackagesTab gym={gym} saving={saving} persist={persist} />}
      {activeTab === "programs" && <ProgramsTab gym={gym} saving={saving} persist={persist} />}
      {activeTab === "gallery" && <GalleryTab gym={gym} saving={saving} persist={persist} />}
    </div>
  );
}

// ── About ─────────────────────────────────────────────────────────────────
function AboutTab({ gym, saving, persist }: { gym: GymData; saving: boolean; persist: (g: GymData, msg: string) => void }) {
  const [about, setAbout] = useState(gym.about);
  useEffect(() => setAbout(gym.about), [gym.about]);
  const dirty = about !== gym.about;

  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <Label>Introductory text shown below the hero banner</Label>
        <Textarea
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          rows={5}
          placeholder="Describe your fitness center — atmosphere, standout features, who it's for…"
        />
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={() => persist({ ...gym, about }, "About Section Updated")}
          className="gap-1.5"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Equipment & Services ─────────────────────────────────────────────────
function EquipmentTab({ gym, saving, persist }: { gym: GymData; saving: boolean; persist: (g: GymData, msg: string) => void }) {
  const [newItem, setNewItem] = useState<Omit<EquipmentItem, "id"> | null>(null);
  const [editing, setEditing] = useState<EquipmentItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);
  const list = gym.equipment;
  const atLimit = list.length >= MAX_LIST;

  function save(next: EquipmentItem[]) {
    persist({ ...gym, equipment: next }, "Equipment & Services Updated");
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Equipment &amp; Services <span className="text-muted-foreground font-normal">({list.length}/{MAX_LIST})</span></h3>
        {!newItem && !editing && (
          <Button size="sm" disabled={atLimit} onClick={() => setNewItem({ name: "", image: "", description: "", icon: "Dumbbell" })} className="gap-1.5">
            <Plus className="w-4 h-4" /> Add Item
          </Button>
        )}
      </div>

      {newItem && (
        <EquipmentForm
          value={newItem}
          saving={saving}
          onChange={setNewItem}
          onCancel={() => setNewItem(null)}
          onSave={() => {
            if (!newItem.name.trim() || !newItem.description.trim()) return;
            save([...list, { id: uid(), ...newItem }]);
            setNewItem(null);
          }}
        />
      )}

      {list.length === 0 && !newItem ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground text-sm">No equipment or services listed yet.</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {list.map((item, idx) => (
            <Card key={item.id}>
              <CardContent className="p-4">
                {editing?.id === item.id ? (
                  <EquipmentForm
                    value={editing}
                    saving={saving}
                    onChange={(v) => setEditing({ ...editing, ...v })}
                    onCancel={() => setEditing(null)}
                    onSave={() => {
                      if (!editing.name.trim() || !editing.description.trim()) return;
                      save(list.map((f) => (f.id === editing.id ? editing : f)));
                      setEditing(null);
                    }}
                  />
                ) : (
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col gap-0.5 shrink-0 pt-1">
                      <button onClick={() => idx > 0 && save(swap(list, idx, idx - 1))} disabled={idx === 0 || saving} className="p-0.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-30"><ArrowUp className="w-3.5 h-3.5" /></button>
                      <button onClick={() => idx < list.length - 1 && save(swap(list, idx, idx + 1))} disabled={idx === list.length - 1 || saving} className="p-0.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-30"><ArrowDown className="w-3.5 h-3.5" /></button>
                    </div>
                    <div className="w-16 h-16 rounded-lg overflow-hidden bg-muted shrink-0 flex items-center justify-center">
                      {item.image ? <img src={item.image} alt={item.name} className="w-full h-full object-cover" /> : <ImageOff className="w-5 h-5 text-muted-foreground" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm">{item.name}</p>
                      <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{item.description}</p>
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      <button onClick={() => setEditing(item)} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setDeleteTarget({ id: item.id, label: item.name })} className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.label}"?</AlertDialogTitle>
            <AlertDialogDescription>This removes it from the public Gym page immediately.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={() => { if (deleteTarget) { save(list.filter((f) => f.id !== deleteTarget.id)); setDeleteTarget(null); } }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EquipmentForm({ value, saving, onChange, onCancel, onSave }: {
  value: Omit<EquipmentItem, "id"> | EquipmentItem; saving: boolean;
  onChange: (v: any) => void; onCancel: () => void; onSave: () => void;
}) {
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="p-4 space-y-3">
        <div className="space-y-1.5">
          <Label>Name *</Label>
          <Input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="Cardio Zone" />
        </div>
        <div className="space-y-1.5">
          <Label>Icon</Label>
          <Select value={value.icon || "Dumbbell"} onValueChange={(v) => onChange({ ...value, icon: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{ICON_OPTIONS.map((i) => <SelectItem key={i} value={i}>{i}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Image</Label>
          <ImageUpload value={value.image} onChange={(url) => onChange({ ...value, image: url })} folder="gym" label="equipment image" />
        </div>
        <div className="space-y-1.5">
          <Label>Description *</Label>
          <Textarea value={value.description} onChange={(e) => onChange({ ...value, description: e.target.value })} placeholder="Describe this for guests…" />
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={saving || !value.name.trim() || !value.description.trim()} onClick={onSave} className="gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />} Save
          </Button>
          <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Hours ─────────────────────────────────────────────────────────────────
function HoursTab({ gym, saving, persist }: { gym: GymData; saving: boolean; persist: (g: GymData, msg: string) => void }) {
  const [hours, setHours] = useState<HoursRow[]>(gym.hours);
  useEffect(() => setHours(gym.hours), [gym.hours]);
  const dirty = JSON.stringify(hours) !== JSON.stringify(gym.hours);

  function update(i: number, patch: Partial<HoursRow>) {
    setHours(hours.map((h, idx) => (idx === i ? { ...h, ...patch } : h)));
  }

  return (
    <Card>
      <CardContent className="p-5 space-y-1">
        {hours.map((row, i) => (
          <div key={row.day} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
            <span className="w-28 text-sm font-medium shrink-0">{row.day}</span>
            <div className="flex items-center gap-2">
              <Switch checked={!row.closed} onCheckedChange={(checked) => update(i, { closed: !checked })} />
              <span className="text-xs text-muted-foreground w-14">{row.closed ? "Closed" : "Open"}</span>
            </div>
            {!row.closed && (
              <div className="flex items-center gap-2 ml-auto">
                <Input type="time" value={row.open} onChange={(e) => update(i, { open: e.target.value })} className="w-28" />
                <span className="text-muted-foreground text-xs">to</span>
                <Input type="time" value={row.close} onChange={(e) => update(i, { close: e.target.value })} className="w-28" />
              </div>
            )}
          </div>
        ))}
        <div className="pt-3">
          <Button size="sm" disabled={!dirty || saving} onClick={() => persist({ ...gym, hours }, "Operating Hours Updated")} className="gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />} Save Hours
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Membership Packages ──────────────────────────────────────────────────
function PackagesTab({ gym, saving, persist }: { gym: GymData; saving: boolean; persist: (g: GymData, msg: string) => void }) {
  const [newItem, setNewItem] = useState<Omit<PackageItem, "id"> | null>(null);
  const [editing, setEditing] = useState<PackageItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);
  const list = gym.packages;
  const atLimit = list.length >= 12;

  function save(next: PackageItem[]) {
    persist({ ...gym, packages: next }, "Membership Packages Updated");
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Membership Packages <span className="text-muted-foreground font-normal">({list.length}/12)</span></h3>
        {!newItem && !editing && (
          <Button size="sm" disabled={atLimit} onClick={() => setNewItem({ name: "", price: 0, duration: "Monthly", features: [], popular: false })} className="gap-1.5">
            <Plus className="w-4 h-4" /> Add Package
          </Button>
        )}
      </div>

      {newItem && (
        <PackageForm value={newItem} saving={saving} onChange={setNewItem} onCancel={() => setNewItem(null)} onSave={() => {
          if (!newItem.name.trim()) return;
          save([...list, { id: uid(), ...newItem }]);
          setNewItem(null);
        }} />
      )}

      {list.length === 0 && !newItem ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground text-sm">No membership packages yet. This section is hidden on the public page until you add one.</CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {list.map((pkg) => (
            <Card key={pkg.id}>
              <CardContent className="p-4">
                {editing?.id === pkg.id ? (
                  <PackageForm value={editing} saving={saving} onChange={(v) => setEditing({ ...editing, ...v })} onCancel={() => setEditing(null)} onSave={() => {
                    if (!editing.name.trim()) return;
                    save(list.map((p) => (p.id === editing.id ? editing : p)));
                    setEditing(null);
                  }} />
                ) : (
                  <div>
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-semibold text-sm flex items-center gap-1.5">
                          {pkg.name} {pkg.popular && <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />}
                        </p>
                        <p className="text-xs text-muted-foreground">{pkg.duration} · ${Number(pkg.price || 0).toFixed(0)}</p>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <button onClick={() => setEditing(pkg)} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"><Pencil className="w-3.5 h-3.5" /></button>
                        <button onClick={() => setDeleteTarget({ id: pkg.id, label: pkg.name })} className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                    {pkg.features.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {pkg.features.map((f, i) => <li key={i} className="text-xs text-muted-foreground">• {f}</li>)}
                      </ul>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.label}"?</AlertDialogTitle>
            <AlertDialogDescription>This removes it from the public Gym page immediately. Existing members already on this package keep their membership — only the public listing is removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={() => { if (deleteTarget) { save(list.filter((p) => p.id !== deleteTarget.id)); setDeleteTarget(null); } }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PackageForm({ value, saving, onChange, onCancel, onSave }: {
  value: Omit<PackageItem, "id"> | PackageItem; saving: boolean;
  onChange: (v: any) => void; onCancel: () => void; onSave: () => void;
}) {
  const [featureDraft, setFeatureDraft] = useState("");
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5 col-span-2">
            <Label>Package Name *</Label>
            <Input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="Premium Monthly" />
          </div>
          <div className="space-y-1.5">
            <Label>Price (USD)</Label>
            <Input type="number" min={0} value={value.price} onChange={(e) => onChange({ ...value, price: Number(e.target.value) || 0 })} />
          </div>
          <div className="space-y-1.5">
            <Label>Duration Label</Label>
            <Input value={value.duration} onChange={(e) => onChange({ ...value, duration: e.target.value })} placeholder="Monthly / 30 days" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Features</Label>
          <div className="flex gap-2">
            <Input value={featureDraft} onChange={(e) => setFeatureDraft(e.target.value)} placeholder="Full equipment access" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (featureDraft.trim()) { onChange({ ...value, features: [...value.features, featureDraft.trim()] }); setFeatureDraft(""); } } }} />
            <Button type="button" size="sm" variant="outline" onClick={() => { if (featureDraft.trim()) { onChange({ ...value, features: [...value.features, featureDraft.trim()] }); setFeatureDraft(""); } }}>Add</Button>
          </div>
          {value.features.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {value.features.map((f, i) => (
                <span key={i} className="inline-flex items-center gap-1 bg-muted text-xs px-2 py-1 rounded-full">
                  {f}
                  <button onClick={() => onChange({ ...value, features: value.features.filter((_, idx) => idx !== i) })}><X className="w-3 h-3" /></button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={value.popular} onCheckedChange={(v) => onChange({ ...value, popular: v })} />
          <Label className="!mt-0">Mark as "Most Popular"</Label>
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={saving || !value.name.trim()} onClick={onSave} className="gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />} Save
          </Button>
          <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Programs / Personal Training ─────────────────────────────────────────
function ProgramsTab({ gym, saving, persist }: { gym: GymData; saving: boolean; persist: (g: GymData, msg: string) => void }) {
  const [newItem, setNewItem] = useState<Omit<ProgramItem, "id"> | null>(null);
  const [editing, setEditing] = useState<ProgramItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);
  const list = gym.programs;
  const atLimit = list.length >= MAX_LIST;

  function save(next: ProgramItem[]) {
    persist({ ...gym, programs: next }, "Programs Updated");
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Personal Training &amp; Programs <span className="text-muted-foreground font-normal">({list.length}/{MAX_LIST})</span></h3>
        {!newItem && !editing && (
          <Button size="sm" disabled={atLimit} onClick={() => setNewItem({ name: "", description: "", image: "" })} className="gap-1.5">
            <Plus className="w-4 h-4" /> Add Program
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Leave this list empty if you don't offer personal training or fitness programs — the section is hidden on the public page.</p>

      {newItem && (
        <ProgramForm value={newItem} saving={saving} onChange={setNewItem} onCancel={() => setNewItem(null)} onSave={() => {
          if (!newItem.name.trim() || !newItem.description.trim()) return;
          save([...list, { id: uid(), ...newItem }]);
          setNewItem(null);
        }} />
      )}

      {list.length > 0 && (
        <div className="space-y-3">
          {list.map((p) => (
            <Card key={p.id}>
              <CardContent className="p-4">
                {editing?.id === p.id ? (
                  <ProgramForm value={editing} saving={saving} onChange={(v) => setEditing({ ...editing, ...v })} onCancel={() => setEditing(null)} onSave={() => {
                    if (!editing.name.trim() || !editing.description.trim()) return;
                    save(list.map((x) => (x.id === editing.id ? editing : x)));
                    setEditing(null);
                  }} />
                ) : (
                  <div className="flex items-start gap-3">
                    <div className="w-16 h-16 rounded-lg overflow-hidden bg-muted shrink-0 flex items-center justify-center">
                      {p.image ? <img src={p.image} alt={p.name} className="w-full h-full object-cover" /> : <ImageOff className="w-5 h-5 text-muted-foreground" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm">{p.name}</p>
                      <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{p.description}</p>
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      <button onClick={() => setEditing(p)} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setDeleteTarget({ id: p.id, label: p.name })} className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete "{deleteTarget?.label}"?</AlertDialogTitle></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={() => { if (deleteTarget) { save(list.filter((p) => p.id !== deleteTarget.id)); setDeleteTarget(null); } }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProgramForm({ value, saving, onChange, onCancel, onSave }: {
  value: Omit<ProgramItem, "id"> | ProgramItem; saving: boolean;
  onChange: (v: any) => void; onCancel: () => void; onSave: () => void;
}) {
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="p-4 space-y-3">
        <div className="space-y-1.5"><Label>Name *</Label><Input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="1-on-1 Personal Training" /></div>
        <div className="space-y-1.5"><Label>Image</Label><ImageUpload value={value.image} onChange={(url) => onChange({ ...value, image: url })} folder="gym" label="program image" /></div>
        <div className="space-y-1.5"><Label>Description *</Label><Textarea value={value.description} onChange={(e) => onChange({ ...value, description: e.target.value })} /></div>
        <div className="flex gap-2">
          <Button size="sm" disabled={saving || !value.name.trim() || !value.description.trim()} onClick={onSave} className="gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />} Save
          </Button>
          <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Gallery ───────────────────────────────────────────────────────────────
function GalleryTab({ gym, saving, persist }: { gym: GymData; saving: boolean; persist: (g: GymData, msg: string) => void }) {
  const list = gym.gallery;
  const atLimit = list.length >= 24;

  function save(next: string[]) {
    persist({ ...gym, gallery: next }, "Gym Gallery Updated");
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Gym Gallery <span className="text-muted-foreground font-normal">({list.length}/24)</span></h3>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {list.map((url, i) => (
          <div key={i} className="relative aspect-square rounded-lg overflow-hidden bg-muted group">
            {url ? <img src={url} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center"><ImageOff className="w-5 h-5 text-muted-foreground" /></div>}
            <button
              onClick={() => save(list.filter((_, idx) => idx !== i))}
              disabled={saving}
              className="absolute top-1.5 right-1.5 bg-black/60 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        {!atLimit && (
          <div className="aspect-square rounded-lg border-2 border-dashed border-border flex items-center justify-center">
            <ImageUpload value="" onChange={(url) => save([...list, url])} folder="gym" label="gallery image" className="w-full h-full" previewClassName="h-full" />
          </div>
        )}
      </div>
    </div>
  );
}

function swap<T>(arr: T[], i: number, j: number): T[] {
  const next = [...arr];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
