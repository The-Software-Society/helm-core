import { useEffect, useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { RefreshCw } from 'lucide-react'
import { api, connect, connection, onConnectionChange, openSocket } from './lib/api'
import { qc, useNeedsYou, useSessions, wireLiveUpdates } from './lib/queries'
import { useUI } from './lib/store'
import { Sidebar, HelmMark } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { CommandPalette } from './components/CommandPalette'
import { NewSessionModal } from './components/NewSession'
import { OpenProjectModal } from './components/OpenProject'
import { TaskDrawer } from './components/TaskDrawer'
import { FileViewer } from './components/FileViewer'
import { HomeView } from './views/Home'
import { ProjectView } from './views/Project'
import { ReviewsView } from './views/Reviews'
import { HistoryView } from './views/History'
import { SettingsView } from './views/Settings'
import { InsightsView } from './views/Insights'
import { RecoveryBanner } from './components/Recovery'

function useCommands() {
  const ui = useUI()
  const { data: sessions = [] } = useSessions()
  const { data: needs = [] } = useNeedsYou()

  useEffect(() => {
    const run = (cmd: string) => {
      const s = useUI.getState()
      const pid = s.view.name === 'project' ? s.view.id : null
      switch (cmd) {
        case 'palette':
          return s.set({ palette: !s.palette })
        case 'open-project':
          return s.set({ openProject: true })
        case 'new-session':
          return pid ? s.set({ newSession: { projectId: pid } }) : s.set({ palette: true })
        case 'new-shell':
          if (pid) window.dispatchEvent(new CustomEvent('helm:new-shell', { detail: pid }))
          return
        case 'split':
          return pid && s.set({ newSession: { projectId: pid, split: true } })
        case 'close-session': {
          if (s.preview) return s.set({ preview: null })
          if (!pid) return
          const ui = s.projectUI[pid]
          const sid = ui?.panes?.[ui.focus]
          if (sid) s.closePane(pid, sid)
          return
        }
        case 'toggle-sidebar':
          return s.set({ sidebarCollapsed: !s.sidebarCollapsed })
        case 'home':
          return s.go({ name: 'home' })
        case 'needs-you':
          return s.go({ name: 'home' })
        case 'reviews':
          return s.go({ name: 'reviews' })
        case 'insights':
          return s.go({ name: 'insights' })
        case 'settings':
          return s.go({ name: 'settings' })
        case 'next-attention': {
          const item = needs.find((n) => n.kind === 'session') || needs[0]
          if (!item) return
          if (item.kind === 'session' && item.projectId) {
            s.go({ name: 'project', id: item.projectId })
            s.showSession(item.projectId, item.id)
          } else if (item.kind === 'review') s.set({ taskId: item.id })
          else if (item.projectId) s.go({ name: 'project', id: item.projectId })
          return
        }
      }
    }
    const off = window.helm.onCommand(run)
    const onEvt = (e: Event) => run((e as CustomEvent).detail)
    window.addEventListener('helm:command', onEvt)
    // ⌘1–9: jump to the Nth live session in the current project (or across all when on Home)
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !/^[1-9]$/.test(e.key)) return
      const s = useUI.getState()
      const pid = s.view.name === 'project' ? s.view.id : null
      const list = sessions.filter((x) => !x.archived && (!pid || x.projectId === pid)).sort((a, b) => a.createdAt - b.createdAt)
      const target = list[Number(e.key) - 1]
      if (!target) return
      e.preventDefault()
      s.go({ name: 'project', id: target.projectId })
      s.showSession(target.projectId, target.id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      off()
      window.removeEventListener('helm:command', onEvt)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [sessions, needs, ui.view])

  // Dock badge = things waiting on the user.
  useEffect(() => {
    window.helm.setBadge(needs.filter((n) => n.kind !== 'stale').length)
  }, [needs])
}

function Shell() {
  useCommands()
  const view = useUI((s) => s.view)
  const [stale, setStale] = useState(false)
  const [online, setOnline] = useState(true)

  useEffect(() => {
    const c = connection()
    setStale(!!c && !!c.expectedBuild && !!c.build && c.expectedBuild !== c.build)
    onConnectionChange((up) => {
      setOnline(up)
      if (up) void qc.invalidateQueries()
    })
    return window.helm.onDaemonRestarted(async () => {
      const c = await connect()
      qc.invalidateQueries()
      setStale(!!c.build && c.expectedBuild !== c.build)
    })
  }, [])

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        {connection()?.channel === 'dev' && <div className="flex-none border-b border-amber-400/30 bg-amber-400/10 px-4 py-2 text-center text-xs text-amber-200">Helm Core Dev · Separate test workspace</div>}
        <RecoveryBanner />
        {(stale || !online) && (
          <div className="flex h-8 flex-none items-center justify-center gap-3 border-b border-white/5 bg-lav/10 text-[12px] text-lilac">
            {!online ? (
              'Reconnecting to the Helm daemon…'
            ) : (
              <>
                Helm was updated — restart the daemon to load it (running agents stop; Claude &amp; Codex sessions can resume).
                <button className="btn btn-sm" onClick={() => window.helm.restartDaemon()}>
                  <RefreshCw size={12} /> Restart daemon
                </button>
              </>
            )}
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {view.name === 'home' && <HomeView />}
          {view.name === 'project' && <ProjectView key={view.id} projectId={view.id} />}
          {view.name === 'reviews' && <ReviewsView />}
          {view.name === 'history' && <HistoryView />}
          {view.name === 'insights' && <InsightsView />}
          {view.name === 'settings' && <SettingsView section={view.section} />}
        </div>
      </main>
      <CommandPalette />
      <NewSessionModal />
      <OpenProjectModal />
      <TaskDrawer />
      <FileViewer />
      <Toasts />
    </div>
  )
}

export function App() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    connect()
      .then(async () => {
        await Promise.all([api.get('/projects'), api.get('/sessions')])
        openSocket()
        wireLiveUpdates()
        setReady(true)
        requestAnimationFrame(() => { void window.helm.uiReady() })
      })
      .catch((e) => setError(String(e?.message || e)))
  }, [])
  return (
    <QueryClientProvider client={qc}>
      <AnimatePresence mode="wait">
        {ready ? (
          <motion.div key="app" className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}>
            <Shell />
          </motion.div>
        ) : (
          <motion.div key="boot" className="drag flex h-full flex-col items-center justify-center gap-4" exit={{ opacity: 0 }}>
            <div className={error ? '' : 'animate-pulse'}>
              <HelmMark size={44} />
            </div>
            <div className="text-[12.5px] text-white/45">{error ? error : 'Starting Helm…'}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </QueryClientProvider>
  )
}
