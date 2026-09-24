import Sidebar from "@/components/Sidebar";
import AuthGate from "@/components/AuthGate";
import { StoreSelectionProvider } from "@/components/StoreSelection";

// Shared by every route-group layout (marketing/settings/sales/requests/
// history) — was duplicated 5x verbatim, which made the mobile-nav rework
// below a 5-file edit instead of a 1-file one.
export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <StoreSelectionProvider>
        <div className="min-h-screen flex flex-col lg:flex-row bg-paper text-ink">
          <Sidebar />
          <div className="flex-1 box-border px-4 sm:px-8 lg:px-12 pt-20 lg:pt-10 pb-14 flex flex-col gap-6 min-w-0">
            {children}
          </div>
        </div>
      </StoreSelectionProvider>
    </AuthGate>
  );
}
