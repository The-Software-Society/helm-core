import { QueryClient, useMutation, useQuery } from '@tanstack/react-query'
import type {
  Milestone, ModelInfo, NeedsYouItem, Project, ProjectStats, RoleConfig, ServerEvent, Session, Task, TranscriptSummary,
} from '@shared/types'
import { api, subscribe } from './api'
import { toast } from '../components/Toasts'

export const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } },
})

// Live updates from the daemon patch caches in place; coarse `invalidate` keys refetch.
export function wireLiveUpdates() {
  return subscribe((e: ServerEvent) => {
    switch (e.t) {
      case 'session.update':
        qc.setQueryData<Session[]>(['sessions'], (old) => {
          if (!old) return old
          const i = old.findIndex((s) => s.id === e.session.id)
          if (e.session.archived) return old.filter((s) => s.id !== e.session.id)
          return i === -1 ? [...old, e.session] : old.map((s) => (s.id === e.session.id ? e.session : s))
        })
        qc.invalidateQueries({ queryKey: ['needs-you'] })
        qc.invalidateQueries({ queryKey: ['stats'] })
        break
      case 'session.remove':
        qc.setQueryData<Session[]>(['sessions'], (old) => old?.filter((s) => s.id !== e.sessionId))
        break
      case 'project.update':
        qc.setQueryData<Project[]>(['projects'], (old) => {
          if (!old) return old
          const exists = old.some((p) => p.id === e.project.id)
          const next = exists ? old.map((p) => (p.id === e.project.id ? e.project : p)) : [e.project, ...old]
          return next.filter((p) => !p.archived)
        })
        break
      case 'task.update':
      case 'task.remove':
        qc.invalidateQueries({ queryKey: ['tasks'] })
        qc.invalidateQueries({ queryKey: ['task'] })
        qc.invalidateQueries({ queryKey: ['reviews'] })
        qc.invalidateQueries({ queryKey: ['stats'] })
        qc.invalidateQueries({ queryKey: ['needs-you'] })
        break
      case 'milestone.update':
        qc.invalidateQueries({ queryKey: ['milestones'] })
        break
      case 'toast':
        toast(e.message, e.level)
        break
      case 'invalidate':
        for (const k of e.keys) qc.invalidateQueries({ queryKey: [k.split(':')[0]] })
        break
    }
  })
}

export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/projects') })
export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: () => api.get<Session[]>('/sessions') })
export const useStats = () =>
  useQuery({
    queryKey: ['stats'],
    queryFn: async () => Object.fromEntries((await api.get<ProjectStats[]>('/stats')).map((s) => [s.projectId, s])) as Record<string, ProjectStats>,
  })
export const useNeedsYou = () => useQuery({ queryKey: ['needs-you'], queryFn: () => api.get<NeedsYouItem[]>('/needs-you'), refetchInterval: 60_000 })
export const useTasks = (projectId: string) => useQuery({ queryKey: ['tasks', projectId], queryFn: () => api.get<Task[]>(`/tasks?projectId=${projectId}`) })
export const useArchivedTasks = (projectId: string, enabled: boolean) =>
  useQuery({ queryKey: ['tasks', projectId, 'archived'], queryFn: () => api.get<Task[]>(`/tasks?projectId=${projectId}&archived=only`), enabled })
export const useMilestones = (projectId: string) =>
  useQuery({ queryKey: ['milestones', projectId], queryFn: () => api.get<Milestone[]>(`/projects/${projectId}/milestones`) })
export const useTranscripts = (projectPath?: string) =>
  useQuery({
    queryKey: ['transcripts', projectPath || 'all'],
    queryFn: () => api.get<TranscriptSummary[]>(`/transcripts?limit=150${projectPath ? `&projectPath=${encodeURIComponent(projectPath)}` : ''}`),
  })
export const useModels = () => useQuery({ queryKey: ['models'], queryFn: () => api.get<ModelInfo[]>('/models') })
export const useRoles = () => useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleConfig[]>('/roles') })
export const useProviders = () =>
  useQuery({ queryKey: ['providers'], queryFn: () => api.get<{ id: string; label: string; available: boolean; binary: string | null }[]>('/providers') })
export const useReviews = () => useQuery({ queryKey: ['reviews'], queryFn: () => api.get<Task[]>('/reviews') })

/** Mutation helper: run, toast errors, invalidate listed keys. */
export function useAction<A, R>(fn: (a: A) => Promise<R>, opts: { invalidate?: string[]; success?: string | ((r: R) => string) } = {}) {
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      for (const k of opts.invalidate || []) qc.invalidateQueries({ queryKey: [k] })
      if (opts.success) toast(typeof opts.success === 'string' ? opts.success : opts.success(r), 'success')
    },
    onError: (e: Error) => toast(e.message, 'error'),
  })
}
