import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { trackPageView } from "@/lib/analytics";

// Friendly labels for every route defined in src/App.tsx, so the Analytics
// dashboard can show "Room Management" instead of "/admin/rooms". Dynamic
// segments (e.g. /rooms/:id) fall back to a derived label at runtime.
export const PAGE_LABELS: Record<string, string> = {
  "/": "Home",
  "/rooms": "Rooms (Public)",
  "/gallery": "Gallery (Public)",
  "/facilities": "Facilities (Public)",
  "/venues": "Venues (Public)",
  "/gym": "Gym (Public)",
  "/restaurant": "Restaurant (Public)",
  "/about": "About (Public)",
  "/contact": "Contact (Public)",
  "/booking": "Booking (Public)",
  "/booking/confirmation": "Booking Confirmation (Public)",
  "/faq": "FAQ (Public)",
  "/testimonials": "Testimonials (Public)",
  "/menu": "Digital Menu (QR)",
  "/order": "Guest Order (QR)",
  "/admin/login": "Admin Login",
  "/admin/pin": "PIN Login",
  "/admin/setup": "Admin Setup",
  "/admin/dashboard": "Dashboard",
  "/admin/rooms": "Room Management",
  "/admin/venues": "Venue Management",
  "/admin/bookings": "All Bookings",
  "/admin/checkin": "Check-In",
  "/admin/checkout": "Check Out",
  "/admin/room-reservations": "Room Reservations",
  "/admin/guests": "Guests",
  "/admin/users": "Users & Roles",
  "/admin/roles": "Roles",
  "/admin/reports": "Reports",
  "/admin/audit-log": "Audit Log",
  "/admin/diagnostics": "Diagnostics",
  "/admin/bug-management": "Bug Management",
  "/admin/deleted-records": "Deleted Records",
  "/admin/cms": "Website CMS",
  "/admin/facilities": "Facilities Management",
  "/admin/gallery": "Gallery Management",
  "/admin/reviews": "Reviews Management",
  "/admin/restaurant-menu": "Restaurant Menu Management",
  "/admin/settings": "Settings",
  "/admin/inventory": "Inventory",
  "/admin/housekeeping": "Housekeeping",
  "/admin/housekeeping/assignments": "Room Assignments",
  "/admin/lost-found": "Lost & Found",
  "/admin/maintenance": "Maintenance",
  "/admin/attendance": "Attendance",
  "/admin/attendance/record": "Attendance Record",
  "/admin/sales/new": "New Sale",
  "/admin/sales/history": "Sales History",
  "/admin/orders/new": "New Order",
  "/admin/orders/history": "Order History",
  "/admin/expenses": "Expenses",
  "/admin/revenue": "Revenue",
  "/admin/financial-reports": "Financial Reports",
  "/admin/staff-performance": "Staff Performance",
  "/admin/payments": "Payments",
  "/admin/approvals": "Approvals",
  "/admin/messages": "Messages",
  "/admin/bar-menu": "Bar Menu",
  "/admin/bar/new-sale": "Bar New Sale",
  "/admin/bar/sales-history": "Bar Sales History",
  "/admin/bar-inventory": "Bar Inventory",
  "/admin/laundry": "Laundry",
  "/admin/laundry/history": "Laundry History",
  "/admin/tasks": "Task Assignment",
  "/admin/shifts": "Shift Scheduling",
  "/admin/my-tasks": "My Tasks",
  "/admin/gym-cms": "Gym Management",
  "/admin/gym/members": "Gym Members",
  "/admin/gym/checkin": "Gym Check-In",
  "/admin/gym/attendance": "Gym Attendance",
  "/admin/gym/reports": "Gym Reports",
  "/admin/analytics": "Usage Analytics",
};

/** Best-effort friendly label for any path, including dynamic ones like /rooms/:id. */
export function labelForPath(path: string): string {
  if (PAGE_LABELS[path]) return PAGE_LABELS[path];
  if (/^\/rooms\/[^/]+$/.test(path)) return "Room Detail (Public)";
  const seg = path.split("/").filter(Boolean).pop() || "Home";
  return seg.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Mounted once near the app root (inside the Router). Fires a page-view
 * record on every route change across both the public site and the
 * authenticated admin/staff areas.
 */
export function usePageTracking() {
  const [location] = useLocation();
  const lastTracked = useRef<string | null>(null);

  useEffect(() => {
    if (lastTracked.current === location) return; // avoid double-fires from re-renders at the same path
    lastTracked.current = location;
    trackPageView(location, labelForPath(location));
  }, [location]);
}
