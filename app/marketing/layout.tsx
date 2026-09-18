import Sidebar from "@/components/Sidebar";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex bg-paper text-ink">
      <Sidebar />
      <div className="flex-1 box-border px-12 py-10 pb-14 flex flex-col gap-6 min-w-0">
        {children}
      </div>
    </div>
  );
}
