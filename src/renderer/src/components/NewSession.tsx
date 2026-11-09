import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { GitBranch, Sparkles, Terminal, Compass, Hammer, Bug, ShieldCheck, Wrench, LineChart, ChevronDown, Paperclip, X, FileText } from 'lucide-react'
import type { ProviderId, RoleId, Session } from '@shared/types'
import { ROLE_LABELS } from '@shared/types'
import { api } from '../lib/api'
import { useUI } from '../lib/store'
import { qc, useModels, useProjects, useProviders, useRoles, useTasks } from '../lib/queries'
import { modelLabel, PROVIDER_LABEL } from '../lib/format'
import { Modal, ProviderGlyph, Kbd } from './bits'
import { toast } from './Toasts'

type Choice = RoleId | 'shell' | 'pilot' | 'custom'

const ICONS: Record<Choice, any> = {
  plan: Compass, implement: Hammer, bugfix: Bug, review: ShieldCheck, grunt: Wrench, data: LineChart, shell: Terminal, pilot: Sparkles, custom: ChevronDown,
}

export async function launchSession(input: Record<string, unknown>) {
  const s = await api.post<Session>('/sessions', input)
  qc.setQueryData<Session[]>(['sessions'], (old) => (old ? [...old.filter((x) => x.id !== s.id), s] : [s]))
  return s
}

const IMAGE = /\.(png|jpe?g|gif|webp|heic|avif|bmp)$/i
const fileSrc = (path: string) => `helm-file://local${path.split('/').map(encodeURIComponent).join('/')}`
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

/** Real paths for dropped/pasted files; in-memory ones (screenshots) are saved under the data dir first. */
async function filePaths(files: FileList | File[]) {
  return Promise.all(Array.from(files).map(async (f) => {
    const path = window.helm.pathForFile(f)
    if (path) return path
    const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') || 'bin'
    return window.helm.saveAttachment(f.name && f.name !== 'image.png' ? f.name : `screenshot.${ext}`, await f.arrayBuffer())
  }))
}

export function NewSessionModal() {
  const { newSession, set, showSession } = useUI()
  const open = !!newSession
  const projectId = newSession?.projectId || ''
  const { data: projects = [] } = useProjects()
  const { data: roles = [] } = useRoles()
  const { data: models = [] } = useModels()
  const { data: providers = [] } = useProviders()
  const { data: tasks = [] } = useTasks(projectId)
  const project = projects.find((p) => p.id === projectId)

  const [choice, setChoice] = useState<Choice>('implement')
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [prompt, setPrompt] = useState('')
  const [worktree, setWorktree] = useState(false)
  const [taskId, setTaskId] = useState('')
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    setPrompt('')
    setFiles([])
    setTaskId(newSession?.taskId || '')
    setWorktree(false)
    setTimeout(() => promptRef.current?.focus(), 80)
  }, [open, newSession?.taskId])

  // Role choice drives provider/model/effort defaults (always overridable).
  useEffect(() => {
    if (choice === 'shell' || choice === 'custom') return
    const r = roles.find((x) => x.role === (choice === 'pilot' ? 'plan' : choice))
    if (r) {
      setProvider(r.provider)
      setModel(r.model)
      setEffort(r.effort || '')
    }
  }, [choice, roles])

  const providerModels = useMemo(() => models.filter((m) => m.provider === provider), [models, provider])
  const selectedModel = providerModels.find((m) => m.slug === model)
  const efforts = selectedModel?.efforts ?? (providerModels.length > 0 && providerModels.every((m) => m.efforts.length === 0) ? [] : ['low', 'medium', 'high'])
  const openTasks = tasks.filter((t) => !['done', 'wont_do'].includes(t.status))

  async function attach(list: FileList | File[] | string[]) {
    try {
      const paths = typeof list[0] === 'string' ? (list as string[]) : await filePaths(list as File[])
      setFiles((old) => [...old, ...paths.filter((p) => p && !old.includes(p))])
    } catch (e) {
      toast((e as Error).message, 'error')
    }
    promptRef.current?.focus()
  }

  async function go() {
    if (!project || busy || (choice !== 'shell' && !providers.find((p) => p.id === provider)?.available)) return
    setBusy(true)
    try {
      const isShell = choice === 'shell'
      const text = prompt.trim()
      // Paths go in the prompt itself, the same thing dropping a file onto a terminal does; both CLIs read them from there.
      const full = [text, files.length ? `Attached:\n${files.map((f) => `- ${f}`).join('\n')}` : ''].filter(Boolean).join('\n\n')
      const s = await launchSession({
        projectId,
        provider: isShell ? 'shell' : provider,
        role: isShell || choice === 'custom' || choice === 'pilot' ? null : choice,
        model: isShell ? null : model || null,
        effort: isShell ? null : effort || null,
        prompt: isShell ? undefined : full || undefined,
        taskId: taskId || null,
        worktree,
        orchestrator: choice === 'pilot',
        name: choice === 'pilot' ? 'Helm Pilot' : !text && files.length ? files[0].split('/').pop() : undefined,
      })
      showSession(projectId, s.id, newSession?.split)
      set({ newSession: null })
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const choices: Choice[] = ['plan', 'implement', 'bugfix', 'review', 'grunt', 'data', 'shell', 'pilot']

  return (
    <Modal open={open} onClose={() => set({ newSession: null })} width={640} eyebrow={project?.name} title={newSession?.split ? 'Split with a new session' : 'New session'}>
      <div
        className="relative px-6 pt-3 pb-5"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.metaKey) go()
        }}
        onDragOver={(e) => {
          if (choice === 'shell' || !e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
        onDrop={(e) => {
          setDragging(false)
          if (choice === 'shell' || !e.dataTransfer.files.length) return
          e.preventDefault()
          void attach(e.dataTransfer.files)
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border border-dashed border-lilac/60 bg-lilac/[0.06] text-[12.5px] text-lilac">
            Drop to attach to the opening prompt
          </div>
        )}
        <div className="grid grid-cols-4 gap-2">
          {choices.map((c) => {
            const I = ICONS[c]
            const r = roles.find((x) => x.role === c)
            const label = c === 'shell' ? 'Shell' : c === 'pilot' ? 'Pilot' : ROLE_LABELS[c as RoleId].label
            const sub = c === 'shell' ? 'Plain terminal' : c === 'pilot' ? 'Orchestrates others' : r ? `${PROVIDER_LABEL[r.provider]} · ${modelLabel(r.model)}` : ''
            return (
              <button
                key={c}
                onClick={() => setChoice(c)}
                className={clsx(
                  'group relative flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-all duration-300',
                  choice === c ? 'border-lav/60 bg-lav/[0.12] shadow-[0_0_0_3px_rgba(134,67,255,.12)]' : 'border-white/[0.07] bg-white/[0.025] hover:border-white/15 hover:bg-white/[0.04]',
                )}
              >
                <I size={15} className={choice === c ? 'text-lilac' : 'text-white/50'} strokeWidth={1.7} />
                <span className="text-[12.5px] font-medium">{label}</span>
                <span className="w-full truncate text-[10.5px] text-white/55">{sub}</span>
              </button>
            )
          })}
        </div>

        {choice !== 'shell' && (
          <div className="mt-4 grid grid-cols-[1fr_1.4fr_1fr] gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] tracking-wide text-white/55 uppercase">Agent</span>
              <div className="relative">
                <select className="field !pl-8" value={provider} onChange={(e) => (setProvider(e.target.value as ProviderId), setModel(''), setEffort(''), setChoice(choice === 'pilot' ? 'pilot' : 'custom'))}>
                  {providers
                    .filter((p) => p.id !== 'shell')
                    .map((p) => (
                      <option key={p.id} value={p.id} disabled={!p.available}>
                        {p.label}
                        {!p.available ? ' (not installed)' : ''}
                      </option>
                    ))}
                </select>
                <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2">
                  <ProviderGlyph provider={provider} />
                </span>
              </div>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] tracking-wide text-white/55 uppercase">Model</span>
              <select className="field" value={model} onChange={(e) => (setModel(e.target.value), setEffort(providerModels.find((m) => m.slug === e.target.value)?.defaultEffort || ''), choice !== 'pilot' && setChoice('custom'))}>
                <option value="">CLI default</option>
                {providerModels.map((m) => (
                  <option key={m.slug} value={m.slug}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </label>
            {efforts.length > 0 ? (
              <label className="flex flex-col gap-1">
                <span className="text-[10.5px] tracking-wide text-white/55 uppercase">Effort</span>
                <select className="field" value={effort} onChange={(e) => setEffort(e.target.value)}>
                  <option value="">Default</option>
                  {efforts.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </label>
            ) : <div />}
          </div>
        )}

        {choice !== 'shell' && (
          <div className="relative mt-3">
            <textarea
              ref={promptRef}
              className="field min-h-[92px] resize-none !pr-10 font-[450] leading-relaxed"
              placeholder={choice === 'pilot' ? 'What should the pilot oversee while you are away?' : 'Opening prompt (optional) — paste or drop screenshots and files · ⌘↵ to launch'}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={(e) => {
                if (!e.clipboardData.files.length) return
                e.preventDefault()
                void attach(e.clipboardData.files)
              }}
            />
            <button
              className="absolute top-2 right-2 rounded-md p-1.5 text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/80"
              title="Attach files"
              onClick={async () => { const p = await window.helm.pickFiles(); if (p.length) void attach(p) }}
            >
              <Paperclip size={14} />
            </button>
          </div>
        )}

        {choice !== 'shell' && files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {files.map((f) => (
              <span key={f} className="group flex max-w-[260px] items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] py-1 pr-1 pl-1 text-[11.5px] text-white/75" title={tilde(f)}>
                {IMAGE.test(f)
                  ? <img src={fileSrc(f)} className="h-6 w-6 shrink-0 rounded object-cover" />
                  : <FileText size={13} className="mx-1 shrink-0 text-white/45" />}
                <span className="truncate">{f.split('/').pop()}</span>
                <button className="shrink-0 rounded p-0.5 text-white/40 hover:bg-white/[0.08] hover:text-white/80" title="Remove" onClick={() => setFiles(files.filter((x) => x !== f))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        {choice !== 'shell' && choice !== 'pilot' && (
          <div className="mt-3 flex items-center gap-2">
            <select className="field !w-auto flex-1" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">No task — freeform session</option>
              {openTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <button
              onClick={() => setWorktree(!worktree)}
              className={clsx('btn', worktree && '!border-lav/50 !bg-lav/15 !text-lilac')}
              title="Run in an isolated git worktree so parallel agents don't collide"
            >
              <GitBranch size={13} /> Worktree
            </button>
          </div>
        )}

        <div className="mt-5 flex items-center gap-3">
          <span className="text-[11.5px] text-white/55">
            {project?.path.replace(/^\/Users\/[^/]+/, '~')}
          </span>
          <span className="flex-1" />
          <button className="btn btn-ghost" onClick={() => set({ newSession: null })}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !project || (choice !== 'shell' && !providers.find((p) => p.id === provider)?.available)} onClick={go}>
            Launch <Kbd>⌘↵</Kbd>
          </button>
        </div>
      </div>
    </Modal>
  )
}
