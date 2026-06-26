import TopHeader from '@/components/shell/TopHeader'
import LeftNav from '@/components/shell/LeftNav'
import RightAISidebar from '@/components/shell/RightAISidebar'
import CommandPalette from '@/components/shell/CommandPalette'
import NoClusterBanner from '@/components/shell/NoClusterBanner'
import { RealtimeProvider } from '@/components/providers/RealtimeProvider'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <RealtimeProvider>
      <div className="flex flex-col h-screen bg-surface-950 overflow-hidden">
        <TopHeader />
        <div className="flex flex-1 min-h-0">
          <LeftNav />
          <main className="flex-1 overflow-y-auto scrollbar-none">
            <NoClusterBanner />
            {children}
          </main>
          <RightAISidebar />
        </div>
        <CommandPalette />
      </div>
    </RealtimeProvider>
  )
}
