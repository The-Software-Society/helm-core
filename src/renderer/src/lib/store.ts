import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ProjectTab = 'terminals' | 'plan' | 'history' | 'brief'
export type View =
  | { name: 'home' }
  | { name: 'project'; id: string }
  | { name: 'reviews' }
  | { name: 'insights' }
  | { name: 'settings'; section?: string }
  | { name: 'history' }

export interface ProjectUI {
  tab: ProjectTab
  panes: string[] // session ids shown side by side (1–3)
  focus: number
}

interface UIState {
  view: View
  back: View[]
  sidebarCollapsed: boolean
  projectUI: Record<string, ProjectUI>
  palette: boolean
  newSession: { projectId: string; taskId?: string; split?: boolean } | null
  openProject: boolean
  taskId: string | null
  preview: { path: string; line?: number; col?: number; sessionId?: string } | null
  go(v: View): void
  goBack(): void
  setProjectUI(pid: string, patch: Partial<ProjectUI>): void
  showSession(pid: string, sid: string, split?: boolean): void
  closePane(pid: string, sid: string): void
  set(patch: Partial<UIState>): void
}

const defaultUI: ProjectUI = { tab: 'terminals', panes: [], focus: 0 }

export const useUI = create<UIState>()(
  persist(
    (set, get) => ({
      view: { name: 'home' },
      back: [],
      sidebarCollapsed: false,
      projectUI: {},
      palette: false,
      newSession: null,
      openProject: false,
      taskId: null,
      preview: null,
      go: (v) => {
        const cur = get().view
        if (JSON.stringify(cur) === JSON.stringify(v)) return
        set({ view: v, back: [...get().back.slice(-30), cur] })
      },
      goBack: () => {
        const b = get().back
        if (!b.length) return
        set({ view: b[b.length - 1], back: b.slice(0, -1) })
      },
      setProjectUI: (pid, patch) => set({ projectUI: { ...get().projectUI, [pid]: { ...defaultUI, ...get().projectUI[pid], ...patch } } }),
      showSession: (pid, sid, split) => {
        const ui = { ...defaultUI, ...get().projectUI[pid] }
        let panes = ui.panes.filter(Boolean)
        const existing = panes.indexOf(sid)
        let focus = existing
        if (existing === -1) {
          if (split && panes.length < 3) {
            panes = [...panes, sid]
            focus = panes.length - 1
          } else if (panes.length === 0) {
            panes = [sid]
            focus = 0
          } else {
            panes = panes.map((p, i) => (i === ui.focus ? sid : p))
            focus = Math.min(ui.focus, panes.length - 1)
          }
        }
        set({ projectUI: { ...get().projectUI, [pid]: { ...ui, tab: 'terminals', panes, focus } } })
      },
      closePane: (pid, sid) => {
        const ui = { ...defaultUI, ...get().projectUI[pid] }
        const panes = ui.panes.filter((p) => p !== sid)
        set({ projectUI: { ...get().projectUI, [pid]: { ...ui, panes, focus: Math.max(0, Math.min(ui.focus, panes.length - 1)) } } })
      },
      set: (patch) => set(patch),
    }),
    {
      name: 'helm-ui',
      partialize: (s) => ({ view: s.view, sidebarCollapsed: s.sidebarCollapsed, projectUI: s.projectUI }),
    },
  ),
)

export const projectUI = (pid: string): ProjectUI => ({ ...defaultUI, ...useUI.getState().projectUI[pid] })
