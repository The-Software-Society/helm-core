// Helm daemon (hubd): owns terminals, the database, and every integration.
// Runs detached from the UI so agents survive window crashes and app restarts.
import { log } from './util'
import { db } from './db'
import { startServer } from './server'
import { daemonToken, initRuntime } from './runtime'
import { configurePtyHost } from './ptyhost/client'
import { registerCoreRoutes } from './routes'
import { reconcileOnBoot, shutdownAll, startCheckpoints } from './pty/manager'
import { refreshModels } from './services/models'
import { scanAll, startWatching } from './transcripts/indexer'
import { registerScheduleRoutes, startScheduler, stopScheduler } from './scheduler'
import { shellEnv } from './env'
import { registerInsightsRoutes } from './services/insights'
import net from 'node:net'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { DATA_DIR } from './paths'

const PORT = Number(process.env.HELM_PORT) || 47831

/** One daemon per data dir: whoever holds the lock socket wins; a stale socket is reclaimed. */
function acquireLock(): Promise<boolean> {
  // Unix socket paths max out at 104 bytes on macOS — keep it short and keyed to the data dir.
  const sock = join(tmpdir(), `helm-${createHash('sha1').update(DATA_DIR).digest('hex').slice(0, 12)}.sock`)
  return new Promise((resolve) => {
    const server = net.createServer((c) => c.end())
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EEXIST') {
        log('lock socket unavailable, continuing without single-instance guard', e)
        return resolve(true)
      }
      const probe = net.connect(sock)
      probe.once('connect', () => (probe.destroy(), resolve(false)))
      probe.once('error', () => {
        try {
          unlinkSync(sock)
        } catch {}
        server.listen(sock, () => resolve(true))
      })
    })
    server.listen(sock, () => resolve(true))
    server.unref()
  })
}

async function main() {
  // A previous daemon may still be shutting down (restart); give it a few seconds to release the lock.
  let locked = false
  for (let i = 0; i < 16 && !(locked = await acquireLock()); i++) await new Promise((r) => setTimeout(r, 500))
  if (!locked) {
    log(`hubd pid=${process.pid}: another daemon owns ${DATA_DIR} — exiting`)
    process.exit(0)
  }
  log(`hubd starting pid=${process.pid}`)
  process.title = 'helm-core-hubd'
  shellEnv() // resolve once up front
  configurePtyHost({ daemonToken: daemonToken() })
  await reconcileOnBoot()
  startCheckpoints()
  refreshModels()
  registerCoreRoutes()
  registerScheduleRoutes()
  registerInsightsRoutes()
  const port = await startServer(PORT)
  initRuntime(port)
  log(`hubd listening on 127.0.0.1:${port}`)
  if (process.send) process.send({ ready: true, port })

  void scanAll()
  startWatching()
  startScheduler()
}

function shutdown(sig: string) {
  log(`hubd ${sig} — shutting down`)
  stopScheduler()
  shutdownAll()
  try {
    db.close()
  } catch {}
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', (e) => log('uncaught', e))
process.on('unhandledRejection', (e) => log('unhandled rejection', e))

main().catch((e) => {
  log('hubd failed to start', e)
  process.exit(1)
})
