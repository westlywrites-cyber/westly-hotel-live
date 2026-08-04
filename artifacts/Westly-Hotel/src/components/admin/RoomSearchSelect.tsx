import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, BedDouble } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, formatCurrency } from "@/lib/utils";

export interface SearchableRoom {
  id: string;
  number: string;
  name?: string | null;
  type?: string | null;
  status?: string | null;
  price?: number | null;
}

interface RoomSearchSelectProps {
  rooms: SearchableRoom[];
  value: string;
  onChange: (roomId: string) => void;
  loading?: boolean;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Searchable room picker for check-in flows (Requirement: "Room Search
 * During Check-In"). Replaces a plain <Select> — which forces the
 * Receptionist to scroll the entire room list — with a filterable combobox
 * that matches on room number, room name, room type, or room status, so it
 * stays fast and usable for hotels with a large room inventory.
 */
export default function RoomSearchSelect({
  rooms, value, onChange, loading, placeholder, disabled,
}: RoomSearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selected = useMemo(() => rooms.find(r => r.id === value), [rooms, value]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter(r =>
      r.number?.toLowerCase().includes(q) ||
      r.name?.toLowerCase().includes(q) ||
      r.type?.toLowerCase().includes(q) ||
      r.status?.toLowerCase().includes(q)
    );
  }, [rooms, search]);

  const label = selected
    ? `Room ${selected.number}${selected.type ? ` — ${selected.type}` : ""}${selected.price != null ? ` (${formatCurrency(selected.price)}/night)` : ""}`
    : "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled || loading}
          className="w-full justify-between font-normal"
        >
          <span className="truncate text-left">
            {loading ? "Loading rooms…" : label || (placeholder ?? "Search rooms by number, name, type, or status…")}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder="Search by number, name, type, or status…"
          />
          <CommandList className="max-h-64">
            <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">
              No rooms match your search.
            </CommandEmpty>
            <CommandGroup>
              {filtered.map(room => (
                <CommandItem
                  key={room.id}
                  value={room.id}
                  onSelect={() => {
                    onChange(room.id);
                    setSearch("");
                    setOpen(false);
                  }}
                  className="flex items-center gap-2"
                >
                  <Check className={cn("h-4 w-4 shrink-0", value === room.id ? "opacity-100" : "opacity-0")} />
                  <BedDouble className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="font-medium">Room {room.number}</span>
                  {room.name && <span className="text-muted-foreground">· {room.name}</span>}
                  <span className="text-muted-foreground text-xs">{room.type}</span>
                  {room.price != null && (
                    <span className="ml-auto text-xs text-muted-foreground shrink-0">{formatCurrency(room.price)}/night</span>
                  )}
                  {room.status && (
                    <Badge variant="outline" className="ml-1 text-[10px] shrink-0 capitalize">{room.status}</Badge>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}