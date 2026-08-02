import type { Env } from "../_shared/firebaseRest";
import { fsGet, fsQuery, fsAdd, serverTimestamp } from "../_shared/firebaseRest";
import { jsonResponse, HttpError } from "../_shared/admin";
import { logServerAction } from "../_shared/serverAudit";

interface CartLineInput {
  id: string;
  name?: string;
  quantity: number;
}

// ══════════════════════════════════════════════════════════════════════════
// Secure online food ordering — room-billed orders only.
//
// This MUST run server-side, for the same reason verify-pin.ts does: the
// check "does this guest name + room number match a currently checked-in
// guest?" requires reading the `bookings` collection, and Firestore rules
// correctly deny that to an unauthenticated public visitor (there is no
// safe way to let a browser enumerate who's staying in which room).
//
// So the whole flow — verify identity, re-price the cart against the
// published menu, and create the order — happens here in one atomic
// server action using elevated (server-side) Firestore access, which
// bypasses security rules by design for trusted server code. firestore.rules
// was updated alongside this function so a client can no longer self-declare
// a roomNumber on an order at all — only this function can, and only after
// verification succeeds. Table orders (walk-in restaurant diners, not tied
// to any room) are unaffected and still go through the existing client-side
// path.
// ══════════════════════════════════════════════════════════════════════════
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  try {
    const body = await request.json<any>();

    const guestName = typeof body.guestName === "string" ? body.guestName.trim() : "";
    const roomNumber = typeof body.roomNumber === "string" ? body.roomNumber.trim() : "";
    const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : "";
    const paymentMethod = body.paymentMethod === "pay_on_delivery" ? "pay_on_delivery" : "room_charge";
    const items: CartLineInput[] = Array.isArray(body.items) ? body.items : [];

    if (!guestName || guestName.length > 100) {
      throw new HttpError(400, "Enter your name as it appears on your reservation.");
    }
    if (!roomNumber || roomNumber.length > 20) {
      throw new HttpError(400, "Enter your room number.");
    }
    if (items.length === 0 || items.length > 40) {
      throw new HttpError(400, "Your cart is empty.");
    }

    // ── 1. Re-price and validate every line against the live published menu.
    // Never trust name/price/availability sent by the client — only the id
    // and requested quantity are used from the request body.
    const menuSnap = await fsGet(env, "cms_content", "restaurant_menu");
    const menuItems: any[] = menuSnap.exists ? (menuSnap.data()?.data || []) : [];
    const menuById = new Map(menuItems.map((m: any) => [m.id, m]));

    const validatedItems = items.map((line) => {
      const id = typeof line.id === "string" ? line.id : "";
      const menuItem = menuById.get(id);
      if (!menuItem || menuItem.available === false) {
        throw new HttpError(400, "One of the items in your cart is no longer available. Please refresh the menu and try again.");
      }
      const quantity = Math.max(1, Math.min(20, Math.floor(Number(line.quantity) || 1)));
      return {
        id: menuItem.id,
        name: menuItem.name,
        price: menuItem.price,
        quantity,
        subtotal: menuItem.price * quantity,
        isManual: false,
      };
    });
    const total = validatedItems.reduce((sum, i) => sum + i.subtotal, 0);

    // ── 2. Verify the guest against active (checked-in) booking records.
    // Two plain equality filters — no composite index required.
    const bookings = await fsQuery(env, "bookings", [
      { field: "status", op: "==", value: "checked_in" },
      { field: "roomNumber", op: "==", value: roomNumber },
    ]);

    const normalize = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
    const match = bookings.find((d) => normalize(String(d.data().guestName || "")) === normalize(guestName));

    if (!match) {
      // Same message whether the name, the room, or both were wrong — never
      // reveal which part failed, or this becomes a way to enumerate valid
      // guest names and occupied rooms.
      throw new HttpError(403, "Invalid guest name or room number.");
    }

    // ── 3. Create the order using the server-verified, re-priced data.
    const orderRef = await fsAdd(env, "orders", {
      waiterId: "unassigned",
      waiterName: "Guest (QR Order — Verified)",
      customerName: guestName,
      roomNumber,
      tableNumber: null,
      guestBookingId: match.id,
      items: validatedItems,
      total,
      paymentMethod,
      notes: notes || null,
      hasManualItems: false,
      status: "pending",
      approvalStatus: "pending",
      approvedBy: null,
      approvedByName: null,
      approvedAt: null,
      rejectedReason: null,
      createdAt: serverTimestamp(),
      isDeleted: false,
      source: "qr_menu",
      guestVerified: true,
    });

    // Staff dashboards already listen to `orders` in real time (onSnapshot),
    // so this write alone surfaces the new order immediately — no separate
    // push/notify step needed here.
    logServerAction(env, match.id, guestName, "guest_order_placed", "orders", orderRef.id, null, { total, roomNumber }, "guest").catch(() => {});

    return jsonResponse(200, { orderId: orderRef.id });
  } catch (err: any) {
    if (err instanceof HttpError) return jsonResponse(err.statusCode, { error: err.message });
    console.error("[verify-guest-order] Unexpected error:", err);
    return jsonResponse(500, { error: "Something went wrong. Please try again." });
  }
};
