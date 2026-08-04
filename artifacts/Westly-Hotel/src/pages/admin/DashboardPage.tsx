import { useAuth } from "@/contexts/AuthContext";
import { Redirect } from "wouter";
import SuperAdminDashboard from "@/components/admin/dashboards/SuperAdminDashboard";
import ManagerDashboard from "@/components/admin/dashboards/ManagerDashboard";
import ReceptionistDashboard from "@/components/admin/dashboards/ReceptionistDashboard";
import AccountantDashboard from "@/components/admin/dashboards/AccountantDashboard";
import StaffDashboard from "@/components/admin/dashboards/StaffDashboard";
import WaiterDashboard from "@/components/admin/dashboards/WaiterDashboard";
import HousekeepingDashboard from "@/components/admin/dashboards/HousekeepingDashboard";
import BarAttendantDashboard from "@/components/admin/dashboards/BarAttendantDashboard";
import LaundryValetDashboard from "@/components/admin/dashboards/LaundryValetDashboard";
import OperationsManagerDashboard from "@/components/admin/dashboards/OperationsManagerDashboard";
import GymStaffDashboard from "@/components/admin/dashboards/GymStaffDashboard";

export default function DashboardPage() {
  const { role } = useAuth();

  switch (role) {
    case "super_admin": return <SuperAdminDashboard />;
    case "manager":     return <ManagerDashboard />;
    case "receptionist": return <ReceptionistDashboard />;
      case "accountant":  return <AccountantDashboard />;
    case "staff":       return <StaffDashboard />;
    case "waiter":      return <WaiterDashboard />;
    case "housekeeping": return <HousekeepingDashboard />;
    case "bar_attendant": return <BarAttendantDashboard />;
    case "laundry_valet": return <LaundryValetDashboard />;
    case "operations_manager": return <OperationsManagerDashboard />;
    case "gym_staff":   return <GymStaffDashboard />;
    // maintenance_technician, security_guard, driver, restaurant_attendant,
    // kitchen_staff (and any future role added to rbac.ts without a matching
    // case here) have no dedicated dashboard and only ever hold
    // "view:own_tasks" / "view:own_shifts" permissions (see ROLE_PERMISSIONS
    // in rbac.ts) — this used to silently fall through to
    // <SuperAdminDashboard />, exposing hotel-wide room/booking/revenue
    // summary cards to roles that should never see them. My Tasks is the
    // one page every staff role is already allowed to view (see the
    // /admin/my-tasks route in App.tsx) and shows exactly what these roles
    // are scoped to: their own tasks and upcoming shifts.
    default:            return <Redirect to="/admin/my-tasks" />;
  }
}