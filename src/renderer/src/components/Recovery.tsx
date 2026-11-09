import { useState } from 'react'
import { RotateCcw, FileText } from 'lucide-react'
import { useProjects, useSessions, qc } from '../lib/queries'
import { api } from '../lib/api'
import { useUI } from '../lib/store'
import { Modal } from './bits'
import { toast } from './Toasts'
import { ago, PROVIDER_LABEL } from '../lib/format'

export function RecoveryBanner() {
  const { data: sessions = [] } = useSessions()
  const { data: projects = [] } = useProjects()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [context, setContext] = useState('')
  const pending = sessions.filter((s) => s.recoveryPending && projects.some((p) => p.id === s.projectId))
  if (!pending.length) return null

  async function resume(id?: string) {
    setBusy(true)
    try {
      if (id) await api.post(`/sessions/${id}/restart`, { resume: true })
      else {
        const results = await api.post<{ id: string; error?: string }[]>('/workspace/resume')
        const errors = results.filter((r) => r.error)
        if (errors.length) toast(errors.map((r) => r.error).join('\n'), 'error')
      }
      await qc.invalidateQueries({ queryKey: ['sessions'] })
    } catch (e) { toast((e as Error).message, 'error') }
    finally { setBusy(false) }
  }

  return <>
    <div className="no-drag flex min-h-12 flex-none items-center justify-between gap-3 border-b border-lav/20 bg-lav/10 px-5 py-2 text-[12px]">
      <span className="text-white/80">Workspace restored · {pending.length} interrupted terminal{pending.length === 1 ? '' : 's'} across {new Set(pending.map((s) => s.projectId)).size} project(s)</span>
      <div className="flex shrink-0 gap-2">
        <button className="btn btn-sm" onClick={() => setOpen(true)}>Review recovery</button>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => resume()}><RotateCcw size={12} /> {busy ? 'Resuming…' : 'Resume workspace'}</button>
      </div>
    </div>
    <Modal open={open} onClose={() => setOpen(false)} title="Pick up where you left off" eyebrow="Saved workspace" width={760}>
      <div className="space-y-4 p-6">
        <p className="text-[13px] leading-relaxed text-white/65">Your tasks, evidence and project layout are saved. Claude, Codex and Qwen reload their saved conversation when available; every agent receives a current recovery brief. Shells reopen in their working directory. Interrupted commands need to be checked before retrying.</p>
        {pending.map((s) => <div key={s.id} className="rounded-xl border border-white/10 p-4">
          <div className="text-[13px] font-medium">{projects.find((p) => p.id === s.projectId)?.name} · {s.name}</div>
          <div className="mt-1 text-[11px] text-white/55">{PROVIDER_LABEL[s.provider] || s.provider} · {s.checkpointAt ? `Screen saved ${ago(s.checkpointAt)}` : 'No periodic screen saved yet'} · {s.cwd}</div>
          {s.status === 'error' && <div className="mt-2 text-[12px] text-rose-300">{s.statusDetail}</div>}
          <div className="mt-3 flex gap-2">
            <button className="btn btn-sm" disabled={busy} onClick={() => resume(s.id)}>Resume</button>
            <button className="btn btn-sm" onClick={() => { useUI.getState().go({ name: 'project', id: s.projectId }); useUI.getState().showSession(s.projectId, s.id); setOpen(false) }}>Open project</button>
            <button className="btn btn-ghost btn-sm" onClick={async () => {
              try { const r = await api.get<{ context: string }>(`/sessions/${s.id}/recovery`); setContext(r.context) }
              catch (e) { toast((e as Error).message, 'error') }
            }}><FileText size={12} /> Recovery brief</button>
          </div>
        </div>)}
        {context && <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-black/20 p-4 text-[11px] leading-relaxed text-white/75">{context}</pre>}
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Close</button>
      </div>
    </Modal>
  </>
}
