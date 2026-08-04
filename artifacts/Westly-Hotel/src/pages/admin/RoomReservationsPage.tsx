import { useState, useMemo, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useCollection, useDocument } from "@/hooks/useFirebase";
import { runTransaction, doc, collection, serverTimestamp, writeBatch } from "firebase/firestore";
import { ref, set } from "firebase/database";
import { db, rtdb } from "@/lib/firebase";
import { logAction } from "@/lib/audit";
import {
  notifyCheckIn, notifyBookingApproval, notifyBookingCancelled, notifyBookingModified, notifyPaymentReceived,
} from "@/lib/notifications";
import { pushActivity } from "@/hooks/useRealtime";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Search, UserCheck, Loader2, CheckCircle, Calendar, BedDouble, XCircle, Clock, Globe } from "lucide-react";
import {
  formatDate, formatDateTime, formatCurrency, toFirestoreDate,
  toDateTimeLocalValue, parseDateTimeLocal, combineDateAndTime, withTimeout,
} from "@/lib/utils";
import { where } from "firebase/firestore";
import { format, addDays } from "date-fns";
import { DataError } from "@/components/ui/data-error";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  confirmed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  checked_in: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  checked_out: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400",
  cancelled: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  no_show: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
};

const STATUS_FILTERS = ["all", "pending", "confirmed", "checked_in", "checked_out", "cancelled"] as const;

export default function RoomReservationsPage() {
  const { adminUser, role } = useAuth();
  const { toast } = useToast();
  // Only filter by isDeleted server-side (single-field, so no composite
  // index needed). Combining it with a status filter would require a
  // composite index that doesn't exist in firestore.indexes.json —
  // Firestore then rejects the live query after briefly serving a
  // locally-cached snapshot, which is why lists like this used to flash on
  // screen and then go blank. "Room reservation" (source !== walk_in) and
  // status are both filtered client-side instead.
  const { data: allBookings, loading: bookingsLoading, error: bookingsError } = useCollection<any>("bookings", [where("isDeleted", "!=", true)]);
  const roomReservations = useMemo(
    () => allBookings.filter((b: any) => b.source !== "walk_in"),
    [allBookings]
  );
  // Live subscription — always reflects the Super Admin's latest saved
  // check-out time policy, never a stale/cached copy.
  const { data: settings } = useDocument<any>("settings", "hotel");
  const officialCheckOutTime: string = settings?.checkOutTime || "11:00";

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedBooking, setSelectedBooking] = useState<any>(null);
  const [idDocRef, setIdDocRef] = useState("");
  const [notes, setNotes] = useState("");
  const [checkInDateTime, setCheckInDateTime] = useState("");
  const [paymentOption, setPaymentOption] = useState("pay_at_checkin");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [loading, setLoading] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [success, setSuccess] = useState<any>(null);
  // Synchronous re-entrancy guard — see WalkInPage.tsx for why this is
  // needed in addition to the `loading` state: React state updates aren't
  // synchronous, so a fast double-click can fire handleCheckIn twice before
  // the button re-renders as disabled. That race — two overlapping
  // transactions, one of which finishes and flips `loading` back to false
  // while the other is still writing — is what produced bookings that
  // either saved but stayed on "Processing…", or never saved at all.
  const submittingRef = useRef(false);

  const canManage = role === "super_admin" || role === "manager" || role === "receptionist";

  // Quick, non-check-in status changes (confirm arrival intent, reject,
  // cancel, mark no-show) — mirrors the logic on the All Bookings page so
  // the Receptionist can make routine booking updates without leaving here.
  const handleStatusChange = async (booking: any, newStatus: string) => {
    if (!adminUser) return;
    setIsUpdatingStatus(true);
    try {
      const prevStatus = booking.status;
      const batch = writeBatch(db);
      batch.update(doc(db, "bookings", booking.id), {
        status: newStatus,
        updatedAt: serverTimestamp(),
        updatedBy: adminUser.id,
        updatedByName: adminUser.name,
      });
      batch.set(doc(db, "booking_dates", booking.id), {
        roomId: booking.roomId,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        status: newStatus,
      }, { merge: true });
      await batch.commit();

      await logAction(
        adminUser.id, adminUser.name,
        `booking_status_changed:${prevStatus}→${newStatus}`,
        "bookings", booking.id,
        { status: prevStatus }, { status: newStatus },
        role ?? undefined
      ).catch(() => {});

      toast({ title: "Reservation Updated", description: `Reservation ${newStatus.replace("_", " ")}.` });

      // Real-time alert to the rest of front desk/management. Check-in has
      // its own dedicated notification (notifyCheckIn, fired from
      // handleCheckIn below) — avoid double-firing here.
      if (newStatus === "confirmed" || newStatus === "rejected") {
        notifyBookingApproval(booking.guestName, newStatus === "confirmed", adminUser.name).catch(() => {});
      } else if (newStatus === "cancelled") {
        notifyBookingCancelled(booking.guestName, booking.roomType ?? "room", adminUser.name).catch(() => {});
      } else if (newStatus === "no_show") {
        notifyBookingModified(booking.guestName, `${prevStatus} → ${newStatus}`, adminUser.name).catch(() => {});
      }
    } catch (err: any) {
      toast({ title: "Update Failed", description: err.message, variant: "destructive" });
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  // Open the dialog for a booking, seeding the exact check-in date/time
  // (defaults to now, editable).
  const handleSelectBooking = (booking: any) => {
    setSelectedBooking(booking);
    setCheckInDateTime(toDateTimeLocalValue(new Date()));
    setPaymentOption("pay_at_checkin");
    setPaymentMethod("cash");
  };

  const closeDialog = () => {
    setSelectedBooking(null);
    setCheckInDateTime("");
  };

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return roomReservations.filter((b: any) => {
      const matchStatus = statusFilter === "all" || b.status === statusFilter;
      const matchSearch = !q ||
        b.guestName?.toLowerCase().includes(q) ||
        b.roomNumber?.includes(q) ||
        b.guestEmail?.toLowerCase().includes(q) ||
        b.bookingId?.toLowerCase().includes(q);
      return matchStatus && matchSearch;
    }).sort((a: any, b: any) => {
      const ta = toFirestoreDate(a.createdAt)?.getTime() ?? 0;
      const tb = toFirestoreDate(b.createdAt)?.getTime() ?? 0;
      return tb - ta;
    });
  }, [roomReservations, search, statusFilter]);

  // Bookings still awaiting check-in — these are the ones the "Check In"
  // dialog/button applies to.
  const awaitingCheckIn = (b: any) => b.status === "pending" || b.status === "confirmed";

  // Standard hotel rule: a booking paid for N nights entitles the guest to
  // stay until the hotel's official check-out time on (check-in date + N
  // days) — regardless of what time of day they actually walk in. This is
  // derived automatically from the booking's nights, never hand-picked by
  // the Receptionist, so a late check-in never accidentally shortens what
  // the guest paid for.
  const entitledCheckOut = useMemo(() => {
    if (!selectedBooking || !checkInDateTime) return null;
    const checkInAtDate = parseDateTimeLocal(checkInDateTime);
    if (isNaN(checkInAtDate.getTime())) return null;
    const nights = selectedBooking.nights && selectedBooking.nights > 0 ? selectedBooking.nights : 1;
    const entitledDateOnly = format(addDays(checkInAtDate, nights), "yyyy-MM-dd");
    return combineDateAndTime(entitledDateOnly, officialCheckOutTime);
  }, [selectedBooking, checkInDateTime, officialCheckOutTime]);

  const handleCheckIn = async () => {
    if (!selectedBooking || !adminUser) return;
    if (submittingRef.current) return; // already in flight — ignore the double-fire

    // Exact check-in date/time entered by the Receptionist.
    const checkInAtDate = parseDateTimeLocal(checkInDateTime);
    if (!checkInDateTime || isNaN(checkInAtDate.getTime())) {
      toast({ title: "Check-In Failed", description: "Please enter a valid check-in date and time.", variant: "destructive" });
      return;
    }
    if (!entitledCheckOut) {
      toast({ title: "Check-In Failed", description: "Could not compute the entitled check-out date. Please try again.", variant: "destructive" });
      return;
    }

    submittingRef.current = true;
    setLoading(true);

    // Guest pays now, or the charge is deferred to check-out. Recorded on
    // the booking so Check-Out knows whether the room charge has already
    // been collected and must never charge (or send for approval) twice.
    const payAtCheckIn = paymentOption === "pay_at_checkin";

    try {
      // ── Firestore Transaction: all operations are atomic ─────────────────
      // Wrapped in withTimeout so a stalled connection surfaces a clear,
      // actionable error after 20s instead of leaving the button stuck on
      // "Processing…" indefinitely.
      await withTimeout(runTransaction(db, async (transaction) => {
        const bookingRef = doc(db, "bookings", selectedBooking.id);
        const bookingSnap = await transaction.get(bookingRef);

        if (!bookingSnap.exists()) throw new Error("Booking not found.");
        const currentBooking = bookingSnap.data();
        if (currentBooking.status === "checked_in") throw new Error("Guest is already checked in.");
        if (currentBooking.status === "cancelled" || currentBooking.status === "rejected") {
          throw new Error("Cannot check in a cancelled or rejected booking.");
        }

        // 1. Update booking status — exact check-in date/time, and the
        // auto-computed entitlement (nights paid for, at the official
        // check-out time). nights/totalAmount are untouched — check-in
        // never changes what the guest paid for.
        transaction.update(bookingRef, {
          status: "checked_in",
          checkInAt: checkInAtDate,
          checkOut: entitledCheckOut,
          checkedInBy: adminUser.id,
          checkedInByName: adminUser.name,
          idDocumentRef: idDocRef || null,
          checkInNotes: notes || null,
          // Payment option chosen by the Receptionist at check-in, and
          // whether the room charge has actually been recorded yet. This is
          // what Check-Out reads to decide whether the room charge is still
          // due — it's the single source of truth that prevents the room
          // payment from ever being recorded a second time at check-out.
          paymentOption,
          paymentMethod: payAtCheckIn ? paymentMethod : (currentBooking.paymentMethod ?? null),
          roomPaymentStatus: payAtCheckIn ? "paid" : "pending",
          updatedAt: serverTimestamp(),
        });

        // 1b. Mirror status (and the entitled check-out) into booking_dates
        // so the public availability check keeps seeing this room as
        // occupied for the right range. set+merge (not update) in case this
        // booking predates the booking_dates mirror.
        transaction.set(doc(db, "booking_dates", selectedBooking.id), {
          roomId: selectedBooking.roomId,
          checkIn: currentBooking.checkIn,
          checkOut: entitledCheckOut,
          status: "checked_in",
        }, { merge: true });

        // 2. Update room status in Firestore (authoritative)
        const roomRef = doc(db, "rooms", selectedBooking.roomId || selectedBooking.id);
        transaction.update(roomRef, {
          status: "occupied",
          currentGuest: selectedBooking.guestName,
          currentBookingId: selectedBooking.id,
          statusUpdatedAt: serverTimestamp(),
        });

        // 3. Create dedicated check-in record
        const checkinRef = doc(collection(db, "checkins"));
        transaction.set(checkinRef, {
          bookingId: selectedBooking.id,
          roomId: selectedBooking.roomId,
          roomNumber: selectedBooking.roomNumber,
          guestName: selectedBooking.guestName,
          guestEmail: selectedBooking.guestEmail || null,
          guestPhone: selectedBooking.guestPhone || null,
          idDocumentRef: idDocRef || null,
          checkInTime: serverTimestamp(), // system audit timestamp (record creation)
          checkInAt: checkInAtDate,       // exact date/time entered by the Receptionist
          entitledCheckOutAt: entitledCheckOut, // nights paid for, auto-computed
          staffId: adminUser.id,
          staffName: adminUser.name,
          notes: notes || null,
          isDeleted: false,
        });

        // 3b. Create a payment record — only when the guest is paying now.
        // "Pay at Check-Out" defers this entirely; Check-Out is the one
        // place that will ever create a payment for this booking, so there
        // is exactly one room-payment record per stay either way.
        if (payAtCheckIn) {
          const paymentRef = doc(collection(db, "payments"));
          transaction.set(paymentRef, {
            bookingId: selectedBooking.id,
            guestName: selectedBooking.guestName,
            roomNumber: selectedBooking.roomNumber,
            amount: selectedBooking.totalAmount || 0,
            paymentMethod,
            type: "room_payment",
            recordedBy: adminUser.id,
            recordedByName: adminUser.name,
            createdAt: serverTimestamp(),
            // Every payment starts as Pending Approval — it only counts as
            // company revenue once the Accountant reviews and approves it.
            approvalStatus: "pending",
            approvedBy: null,
            approvedByName: null,
            approvedAt: null,
            rejectedReason: null,
            isDeleted: false,
          });
        }
      }), 20000);
      // ── Transaction complete ─────────────────────────────────────────────

      // 4. Realtime DB — room status (non-atomic, best-effort)
      await set(ref(rtdb, `roomStatus/${selectedBooking.roomId}`), {
        status: "occupied",
        currentGuest: selectedBooking.guestName,
        updatedAt: Date.now(),
      }).catch(() => {});

      // 5. Audit log (non-atomic, non-blocking)
      logAction(
        adminUser.id, adminUser.name,
        "check_in", "bookings", selectedBooking.id,
        { status: "confirmed", checkOut: selectedBooking.checkOut },
        { status: "checked_in", checkInAt: checkInAtDate, checkOut: entitledCheckOut },
        role ?? undefined
      ).catch(() => {});

      // 6. Notification (non-atomic, non-blocking)
      notifyCheckIn(selectedBooking.guestName, selectedBooking.roomNumber, adminUser.name).catch(() => {});

      // 6b. Alert the Accountant (and finance team) only when a payment was
      // actually recorded — "Pay at Check-Out" guests generate no payment
      // yet, so no approval request should go out until they actually pay.
      if (payAtCheckIn) {
        notifyPaymentReceived(selectedBooking.guestName, selectedBooking.totalAmount || 0, paymentMethod, adminUser.name).catch(() => {});
      }

      // 7. Activity feed
      pushActivity({
        message: `${adminUser.name} checked in ${selectedBooking.guestName} (Room ${selectedBooking.roomNumber})`,
        type: "check_in",
        userName: adminUser.name,
        userId: adminUser.id,
      }).catch(() => {});

      setSuccess({
        booking: { ...selectedBooking, checkOut: entitledCheckOut },
        checkInTime: format(checkInAtDate, "h:mm a"),
        payAtCheckIn,
      });
      closeDialog();
      setIdDocRef("");
      setNotes("");

      toast({
        title: "Check-In Complete",
        description: payAtCheckIn
          ? `${selectedBooking.guestName} has been checked in. Payment sent to the Accountant for approval.`
          : `${selectedBooking.guestName} has been checked in. Payment will be collected at check-out.`,
      });
    } catch (err: any) {
      toast({ title: "Check-In Failed", description: err.message || "Something went wrong. Please try again.", variant: "destructive" });
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  };

  if (success) {
    return (
      <div className="max-w-md mx-auto pt-12 text-center space-y-5">
        <div className="w-20 h-20 bg-green-100 dark:bg-green-900/20 rounded-full flex items-center justify-center mx-auto">
          <CheckCircle className="w-10 h-10 text-green-600" />
        </div>
        <div>
          <h2 className="font-serif text-2xl font-bold">Check-In Complete!</h2>
          <p className="text-muted-foreground mt-2">
            <strong>{success.booking.guestName}</strong> has been checked into Room <strong>{success.booking.roomNumber}</strong>.
          </p>
          <p className="text-sm text-muted-foreground mt-1">Check-in time: {success.checkInTime}</p>
        </div>
        <div className="bg-muted rounded-xl p-4 text-sm text-left space-y-2">
          <div className="flex justify-between"><span className="text-muted-foreground">Room Type</span><span>{success.booking.roomType}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Guest May Stay Until</span><span>{formatDateTime(toFirestoreDate(success.booking.checkOut))}</span></div>
          {success.payAtCheckIn ? (
            <div className="flex justify-between"><span className="text-muted-foreground">Total Paid</span><span className="font-bold">{formatCurrency(success.booking.totalAmount || 0)}</span></div>
          ) : (
            <div className="flex justify-between"><span className="text-muted-foreground">Payment</span><span className="font-bold text-orange-600">{formatCurrency(success.booking.totalAmount || 0)} due at check-out</span></div>
          )}
        </div>
        <Button onClick={() => setSuccess(null)} className="w-full">Check In Another Guest</Button>
      </div>
    );
  }
  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h1 className="font-serif text-2xl font-bold flex items-center gap-2">
          <Globe className="w-5 h-5 text-muted-foreground" /> Room Reservations
        </h1>
        <p className="text-muted-foreground text-sm">Guests who booked through the website — confirm arrivals, check guests in, and manage reservation status</p>
      </div>

      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by guest name, room number, email, or booking ID…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {STATUS_FILTERS.map(s => {
          const count = s === "all" ? roomReservations.length : roomReservations.filter((b: any) => b.status === s).length;
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                statusFilter === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {s === "all" ? "All" : s.replace("_", " ")} ({count})
            </button>
          );
        })}
      </div>

      {bookingsLoading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : bookingsError ? (
        <DataError message="We couldn't load room reservations." />
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <UserCheck className="w-10 h-10 mx-auto mb-2 opacity-30" />
          <p>No room reservations found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((booking: any) => (
            <Card
              key={booking.id}
              className={awaitingCheckIn(booking) ? "cursor-pointer hover:border-primary/40 transition-colors" : ""}
              onClick={() => awaitingCheckIn(booking) && handleSelectBooking(booking)}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <span className="text-sm font-bold text-primary">{booking.guestName?.[0]}</span>
                    </div>
                    <div>
                      <p className="font-semibold">{booking.guestName}</p>
                      <p className="text-xs text-muted-foreground">{booking.guestEmail}</p>
                      <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${STATUS_COLORS[booking.status] || ""}`}>
                        {booking.status?.replace("_", " ")}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="flex items-center gap-2 justify-end">
                      <BedDouble className="w-4 h-4 text-muted-foreground" />
                      <span className="font-medium">Room {booking.roomNumber}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{booking.roomType}</p>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                      <Calendar className="w-3 h-3" />
                      <span>Check-in: {formatDateTime(toFirestoreDate(booking.checkInAt || booking.checkIn))}</span>
                    </div>
                  </div>
                </div>

                {canManage && (booking.status === "pending" || booking.status === "confirmed") && (
                  <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-border" onClick={e => e.stopPropagation()}>
                    {booking.status === "pending" && (
                      <>
                        <Button
                          size="sm"
                          className="gap-1 bg-green-600 hover:bg-green-700 text-white"
                          onClick={() => handleStatusChange(booking, "confirmed")}
                          disabled={isUpdatingStatus}
                        >
                          <CheckCircle className="w-3.5 h-3.5" /> Confirm Arrival
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="gap-1"
                          onClick={() => handleStatusChange(booking, "rejected")}
                          disabled={isUpdatingStatus}
                        >
                          <XCircle className="w-3.5 h-3.5" /> Reject
                        </Button>
                      </>
                    )}
                    <Button size="sm" variant="outline" className="gap-1" onClick={() => handleSelectBooking(booking)}>
                      <UserCheck className="w-3.5 h-3.5" /> Check In
                    </Button>
                    {booking.status === "confirmed" && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1 border-orange-400 text-orange-600"
                          onClick={() => handleStatusChange(booking, "cancelled")}
                          disabled={isUpdatingStatus}
                        >
                          <XCircle className="w-3.5 h-3.5" /> Cancel
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1 border-orange-400 text-orange-600"
                          onClick={() => handleStatusChange(booking, "no_show")}
                          disabled={isUpdatingStatus}
                        >
                          <Clock className="w-3.5 h-3.5" /> No Show
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Check-In Dialog */}
      {selectedBooking && (
        <Dialog open={!!selectedBooking} onOpenChange={() => closeDialog()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirm Check-In</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="bg-muted rounded-lg p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Guest</span>
                  <span className="font-medium">{selectedBooking.guestName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Room</span>
                  <span className="font-medium">Room {selectedBooking.roomNumber} ({selectedBooking.roomType})</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Nights Paid</span>
                  <span>{selectedBooking.nights || 1} night{(selectedBooking.nights || 1) !== 1 ? "s" : ""}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-bold">{formatCurrency(selectedBooking.totalAmount || 0)}</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Check-In Date &amp; Time *</Label>
                <Input
                  type="datetime-local"
                  required
                  value={checkInDateTime}
                  onChange={e => setCheckInDateTime(e.target.value)}
                />
              </div>

              <div className="rounded-lg border border-border p-3 text-sm space-y-1 bg-primary/5">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Guest May Stay Until</p>
                <p className="font-semibold">{entitledCheckOut ? formatDateTime(entitledCheckOut) : "—"}</p>
                <p className="text-xs text-muted-foreground">
                  Automatically calculated from {selectedBooking.nights || 1} night{(selectedBooking.nights || 1) !== 1 ? "s" : ""} paid
                  for, ending at the hotel's official check-out time (<strong>{officialCheckOutTime}</strong>, set by the Super
                  Admin in Settings). This isn't editable here — if the guest leaves earlier or later, record the actual
                  time on the Check-Out page when they depart.
                </p>
              </div>

              <div className="space-y-2">
                <Label>ID Document Reference (optional)</Label>
                <Input
                  placeholder="Passport / National ID number"
                  value={idDocRef}
                  onChange={e => setIdDocRef(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label>Payment Option *</Label>
                <Select value={paymentOption} onValueChange={setPaymentOption}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pay_at_checkin">Pay at Check-In</SelectItem>
                    <SelectItem value="pay_at_checkout">Pay at Check-Out</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {paymentOption === "pay_at_checkin"
                    ? "Payment is recorded now and sent to the Accountant for approval."
                    : "No payment is recorded now — the booking is marked Payment Pending and charged at check-out."}
                </p>
              </div>

              {paymentOption === "pay_at_checkin" && (
                <div className="space-y-2">
                  <Label>Payment Method</Label>
                  <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">Cash</SelectItem>
                      <SelectItem value="credit_card">Credit Card</SelectItem>
                      <SelectItem value="debit_card">Debit Card</SelectItem>
                      <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2">
                <Label>Notes (optional)</Label>
                <Input
                  placeholder="Any notes for this check-in"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => closeDialog()}>Cancel</Button>
              <Button onClick={handleCheckIn} disabled={loading || !checkInDateTime || !entitledCheckOut} className="gap-2">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />}
                {loading ? "Processing…" : "Complete Check-In"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}