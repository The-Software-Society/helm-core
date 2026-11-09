import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { CheckCheck, Image as ImageIcon, ShieldCheck } from 'lucide-react'
import type { Evidence, Task, TaskEvent } from '@shared/types'
import { api, fileUrl } from '../lib/api'
import { useUI } from '../lib/store'
import { useProjects, useReviews } from '../lib/queries'
import { ago } from '../lib/format'
import { Empty } from '../components/bits'
import { ProjectGlyph } from '../components/Sidebar'
import { StatusPill } from '../components/TaskDrawer'

export function ReviewsView() {
  const { data: reviews = [] } = useReviews()
  const { data: projects = [] } = useProjects()
  const human = reviews.filter((r) => r.status === 'human_review')
  const ai = reviews.filter((r) => r.status === 'ai_review' && !r.reviewError)
  const errors = reviews.filter((r) => r.status === 'ai_review' && r.reviewError)
  const byId = new Map(projects.map((p) => [p.id, p]))

  return (
    <div className="h-full overflow-y-auto">
      <div className="drag h-[46px]" />
      <div className="mx-auto max-w-[1100px] px-8 pb-12">
        <div className="eyebrow">Reviews</div>
        <h1 className="mt-1 font-display text-[24px] font-medium">Your approval queue</h1>
        <p className="mt-1 text-[12.5px] text-white/45">
          Work lands here after an independent AI review passes with evidence. You make the final call — approve to close it, or send notes straight back to the agent.
        </p>

        {human.length === 0 && ai.length === 0 && errors.length === 0 && <Empty icon={<CheckCheck size={26} />} title="Nothing to review" body="When agents submit verified work, it shows up here with screenshots and test output." />}

        {human.length > 0 && (
          <>
            <div className="mt-8 mb-3 flex items-center gap-2">
              <span className="dot dot-waiting" />
              <span className="eyebrow !text-amber">Needs you · {human.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {human.map((t) => (
                <ReviewCard key={t.id} task={t} project={byId.get(t.projectId)} />
              ))}
            </div>
          </>
        )}

        {errors.length > 0 && (
          <>
            <div className="mt-8 mb-3 eyebrow !text-rose">AI review needs attention · {errors.length}</div>
            <div className="grid grid-cols-2 gap-4">{errors.map((t) => <ReviewCard key={t.id} task={t} project={byId.get(t.projectId)} />)}</div>
          </>
        )}
        {ai.length > 0 && (
          <>
            <div className="mt-10 mb-3 flex items-center gap-2">
              <ShieldCheck size={13} className="text-[#5fd8f0]" />
              <span className="eyebrow !text-[#9be9f8]">AI review in progress · {ai.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {ai.map((t) => (
                <ReviewCard key={t.id} task={t} project={byId.get(t.projectId)} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ReviewCard({ task, project }: { task: Task; project?: { name: string; color: string } }) {
  const set = useUI((s) => s.set)
  const { data } = useQuery({
    queryKey: ['task', task.id],
    queryFn: () => api.get<{ task: Task; events: TaskEvent[]; evidence: Evidence[] }>(`/tasks/${task.id}`),
  })
  const shot = data?.evidence.find((e) => e.path && /\.(png|jpe?g|gif|webp)$/i.test(e.path))
  const aiVerdict = [...(data?.events || [])].reverse().find((e) => e.kind === 'review' && e.body.startsWith('AI review'))
  return (
    <button onClick={() => set({ taskId: task.id })} className="glass glass-hover group flex flex-col overflow-hidden rounded-2xl text-left hover:-translate-y-0.5">
      {shot ? (
        <div className="relative h-[170px] overflow-hidden border-b border-white/[0.06]">
          <img src={fileUrl(shot.path!)} className="h-full w-full object-cover object-top transition duration-700 group-hover:scale-[1.02]" />
          <div className="absolute inset-0 bg-gradient-to-t from-ink/80 to-transparent" />
        </div>
      ) : (
        <div className="flex h-[70px] items-center justify-center border-b border-white/[0.05] text-white/20">
          <ImageIcon size={18} />
        </div>
      )}
      <div className="flex flex-1 flex-col p-4">
        <div className="mb-1.5 flex items-center gap-2">
          {project && <ProjectGlyph p={project} size={18} />}
          <span className="text-[11.5px] text-white/45">{project?.name}</span>
          <span className="flex-1" />
          <StatusPill status={task.status} />
        </div>
        <div className="font-display text-[14.5px] leading-snug font-medium">{task.title}</div>
        {task.reviewError && <p className="mt-2 text-[12px] text-rose">{task.reviewError}</p>}
        {!task.reviewError && aiVerdict && <div className={clsx('mt-2 line-clamp-4 text-[12px] leading-snug whitespace-pre-wrap text-white/50')}>{aiVerdict.body}</div>}
        <div className="mt-auto flex items-center gap-2 pt-3 text-[11px] text-white/35">
          {data && <span>{data.evidence.length} evidence</span>}
          <span>·</span>
          <span>{ago(task.updatedAt, false)}</span>
        </div>
      </div>
    </button>
  )
}
