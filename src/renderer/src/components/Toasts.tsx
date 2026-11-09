import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, AlertCircle, Info } from 'lucide-react'

type Level = 'info' | 'success' | 'error'
interface T {
  id: number
  message: string
  level: Level
}

let push: ((t: T) => void) | null = null
let n = 0
export function toast(message: string, level: Level = 'info') {
  push?.({ id: ++n, message, level })
}

export function Toasts() {
  const [items, setItems] = useState<T[]>([])
  useEffect(() => {
    push = (t) => {
      setItems((x) => [...x.slice(-3), t])
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), t.level === 'error' ? 7000 : 4200)
    }
    return () => {
      push = null
    }
  }, [])
  const Icon = { info: Info, success: CheckCircle2, error: AlertCircle }
  const color = { info: 'text-lilac', success: 'text-aqua', error: 'text-rose' }
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-[100] flex w-[360px] flex-col gap-2">
      <AnimatePresence>
        {items.map((t) => {
          const I = Icon[t.level]
          return (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 14, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, x: 30 }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              className="glass pointer-events-auto flex items-start gap-2.5 rounded-xl px-3.5 py-3 shadow-2xl shadow-black/40"
              style={{ background: 'rgba(17,14,44,0.92)' }}
            >
              <I size={15} className={`${color[t.level]} mt-px flex-none`} />
              <span className="selectable text-[12.5px] leading-snug text-white/85">{t.message}</span>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
