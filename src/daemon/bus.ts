import { EventEmitter } from 'node:events'
import type { ServerEvent } from '@shared/types'

class Bus extends EventEmitter {
  emitEvent(e: ServerEvent) {
    this.emit('event', e)
  }
  toast(level: 'info' | 'success' | 'error', message: string) {
    this.emitEvent({ t: 'toast', level, message })
  }
  invalidate(...keys: string[]) {
    this.emitEvent({ t: 'invalidate', keys })
  }
}

export const bus = new Bus()
bus.setMaxListeners(100)
