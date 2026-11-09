import { type ReactNode, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import clsx from 'clsx'
import type { Session, SessionStatus } from '@shared/types'
import { PROVIDER_LABEL, modelLabel } from '../lib/format'

export function StatusDot({ status, seen = true, className }: { status: SessionStatus; seen?: boolean; className?: string }) {
  const attention = status === 'waiting' || status === 'done'
  return <span className={clsx('dot', `dot-${status}`, attention && seen && 'dot-seen', className)} title={status} />
}

export const STATUS_TEXT: Record<SessionStatus, string> = {
  starting: 'Starting',
  running: 'Working',
  waiting: 'Needs you',
  done: 'Your turn',
  idle: 'Idle',
  exited: 'Ended',
  error: 'Crashed',
}

export function ProviderGlyph({ provider, size = 14 }: { provider: string; size?: number }) {
  const s = size
  if (provider === 'claude')
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" className="flex-none">
        <path d="M8 1.5l1.3 4.2 4.2-1.2-3 3.2 3 3.3-4.2-1.3L8 14.5 6.7 9.7l-4.2 1.3 3-3.3-3-3.2 4.2 1.2z" fill="#E8A27C" />
      </svg>
    )
  if (provider === 'codex')
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" className="flex-none">
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="#fafafa" strokeWidth="1.4" opacity=".9" />
        <path d="M5.4 6.2L7.2 8l-1.8 1.8M8.6 10h2.2" stroke="#fafafa" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  if (provider === 'qwen')
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" className="flex-none">
        <path d="M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z" fill="none" stroke="#7aa2ff" strokeWidth="1.4" />
      </svg>
    )
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" className="flex-none">
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2.4" fill="none" stroke="rgba(250,250,250,.55)" strokeWidth="1.3" />
      <path d="M4.6 6.4l1.8 1.6-1.8 1.6M8 10.4h3" stroke="rgba(250,250,250,.55)" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </svg>
  )
}

export function SessionMeta({ s }: { s: Session }) {
  return (
    <span className="truncate text-[11px] text-white/40">
      {PROVIDER_LABEL[s.provider]}
      {s.model ? ` · ${modelLabel(s.model)}` : ''}
      {s.effort ? ` · ${s.effort}` : ''}
      {s.branch ? ` · ⎇ ${s.branch.replace('helm/', '')}` : ''}
    </span>
  )
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={clsx('md selectable', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} onClick={(e) => (e.preventDefault(), href && window.helm.openExternal(href))}>
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

export function Modal({ open, onClose, children, width = 560, title, eyebrow }: { open: boolean; onClose: () => void; children: ReactNode; width?: number; title?: string; eyebrow?: string }) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 pt-[12vh] backdrop-blur-[3px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.98, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: 8, scale: 0.99 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            role="dialog" aria-modal="true" aria-label={title || eyebrow || 'Dialog'}
            className="relative max-w-[calc(100vw-32px)] max-h-[76vh] overflow-hidden rounded-2xl border border-white/10 shadow-[0_40px_120px_-20px_rgba(0,0,0,.8)]"
            style={{ width, background: 'linear-gradient(180deg, rgba(24,20,56,.97), rgba(13,10,34,.98))' }}
          >
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-lav/60 to-transparent" />
            {(title || eyebrow) && (
              <div className="px-6 pt-5 pb-1">
                {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
                {title && <div className="font-display text-[19px] font-medium">{title}</div>}
              </div>
            )}
            <div className="max-h-[calc(76vh-70px)] overflow-y-auto">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function Empty({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-16 text-center">
      {icon && <div className="mb-4 text-lilac/70">{icon}</div>}
      <div className="font-display text-[16px] font-medium text-white/90">{title}</div>
      {body && <div className="mt-1.5 max-w-sm text-[12.5px] text-white/45">{body}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function Progress({ value, total, className }: { value: number; total: number; className?: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0
  return (
    <div className={clsx('h-[3px] w-full overflow-hidden rounded-full bg-white/[0.06]', className)}>
      <div
        className="h-full rounded-full transition-[width] duration-700"
        style={{ width: `${pct}%`, background: 'var(--grad-h)', boxShadow: pct ? '0 0 10px rgba(134,67,255,.55)' : undefined }}
      />
    </div>
  )
}

export function Ring({ value, total, size = 36 }: { value: number; total: number; size?: number }) {
  const r = size / 2 - 3
  const c = 2 * Math.PI * r
  const pct = total ? value / total : 0
  return (
    <svg width={size} height={size} className="-rotate-90">
      <defs>
        <linearGradient id="ringg" x1="0" x2="1">
          <stop offset="0" stopColor="#3520f4" />
          <stop offset="1" stopColor="#8643ff" />
        </linearGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,.08)" strokeWidth="3" fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="url(#ringg)"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        style={{ transition: 'stroke-dashoffset .8s cubic-bezier(.16,1,.3,1)' }}
      />
    </svg>
  )
}

export function Aurora() {
  return (
    <div className="aurora">
      <div className="blob b1" />
      <div className="blob b2" />
      <div className="blob b3" />
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>
}
