import { useQuery } from '@tanstack/react-query'
import { FolderOpen, Sparkles } from 'lucide-react'
import type { Project, ProjectKind } from '@shared/types'
import { api } from '../lib/api'
import { useUI } from '../lib/store'
import { qc } from '../lib/queries'
import { ago, tildify } from '../lib/format'
import { Modal } from './bits'
import { toast } from './Toasts'

interface Suggestion {
  path: string
  name: string
  kind: ProjectKind
  last: number
  sessions: number
  messages: number
}

export const KIND_LABEL: Record<ProjectKind, string> = { client: 'Client', passion: 'Passion', internal: 'Internal', other: 'Other' }

export async function openProjectPath(path: string, extra: Partial<Project> = {}) {
  const p = await api.post<Project>('/projects', { path, ...extra })
  await api.post(`/projects/${p.id}/opened`)
  qc.invalidateQueries({ queryKey: ['projects'] })
  qc.invalidateQueries({ queryKey: ['suggestions'] })
  useUI.getState().go({ name: 'project', id: p.id })
  return p
}

export function useSuggestions(enabled = true) {
  return useQuery({ queryKey: ['suggestions'], queryFn: () => api.get<Suggestion[]>('/projects/suggestions'), enabled })
}

export function OpenProjectModal() {
  const { openProject, set } = useUI()
  const { data: suggestions = [], isLoading } = useSuggestions(openProject)

  async function browse() {
    const path = await window.helm.pickFolder()
    if (!path) return
    try {
      await openProjectPath(path)
      set({ openProject: false })
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <Modal open={openProject} onClose={() => set({ openProject: false })} width={620} eyebrow="Projects" title="Open a project">
      <div className="px-6 pt-3 pb-6">
        <button onClick={browse} className="glass glass-hover flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left">
          <FolderOpen size={18} className="text-lilac" strokeWidth={1.6} />
          <div className="flex-1">
            <div className="text-[13px] font-medium">Browse for a folder…</div>
            <div className="text-[11.5px] text-white/40">Any directory — git repo or not</div>
          </div>
        </button>

        <div className="mt-5 mb-2 flex items-center gap-2">
          <Sparkles size={12} className="text-lilac" />
          <span className="eyebrow !text-[10px]">Recently worked on</span>
          <span className="text-[11px] text-white/30">from your Claude &amp; Codex history</span>
        </div>
        {isLoading && <div className="py-6 text-center text-[12px] text-white/35">Reading history…</div>}
        {!isLoading && suggestions.length === 0 && <div className="py-6 text-center text-[12px] text-white/35">Nothing new to suggest — all caught up.</div>}
        <div className="flex flex-col gap-1">
          {suggestions.map((s) => (
            <button
              key={s.path}
              onClick={async () => {
                try {
                  await openProjectPath(s.path)
                  set({ openProject: false })
                } catch (e) {
                  toast((e as Error).message, 'error')
                }
              }}
              className="group flex items-center gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-white/[0.045]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{s.name}</span>
                  <span className="pill !h-[17px] !text-[10px]">{KIND_LABEL[s.kind]}</span>
                </div>
                <div className="truncate text-[11.5px] text-white/35">{tildify(s.path)}</div>
              </div>
              <div className="text-right text-[11px] text-white/35">
                <div>{ago(s.last, false)}</div>
                <div>
                  {s.sessions} session{s.sessions === 1 ? '' : 's'}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
