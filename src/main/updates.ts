import { app, dialog, BrowserWindow } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, openSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const updater = () => app.isPackaged ? join(process.resourcesPath, 'helm-update.py') : resolve('scripts/helm-update.py')
const python = ['/usr/local/bin/python3', '/opt/homebrew/bin/python3', '/usr/bin/python3'].find(existsSync) || '/usr/bin/python3'
let applying = false

export async function backupWorkspace(data: string): Promise<string> {
  const folder = join(data, 'backups')
  mkdirSync(folder, { recursive: true })
  const path = join(folder, `before-service-update-${Date.now()}.sqlite`)
  await exec(python, [updater(), 'backup', data, path])
  return path
}

const readJson = (path: string) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** The candidate `pnpm update:prepare` sealed last. */
function candidateState(data: string, target: string): { state: 'ready' | 'installed' | 'missing'; app?: string; createdAt?: number } {
  const c = readJson(join(data, 'updates/candidate.json'))
  if (!c?.app || !existsSync(join(c.app, 'Contents/Resources/helm-release.json'))) return { state: 'missing' }
  const manifest = readJson(join(c.app, 'Contents/Resources/helm-release.json'))
  if (!manifest?.sha256 || manifest.sha256 !== c.sha256) return { state: 'missing' }
  const installed = readJson(join(target, 'Contents/Resources/helm-release.json'))
  if (installed?.sha256 === manifest.sha256) return { state: 'installed' }
  return { state: 'ready', app: c.app, createdAt: Number(manifest.createdAt) * 1000 }
}

/** One click: installs the last sealed candidate. */
export async function installTestedUpdate(win: BrowserWindow, data: string, ensureDaemon: () => Promise<unknown>) {
  if (applying) return
  applying = true
  try {
    const target = process.env.HELM_INSTALL_TARGET || join(homedir(), 'Applications/Helm Core.app')
    const candidate = candidateState(data, target)
    if (candidate.state !== 'ready' || !candidate.app) {
      await dialog.showMessageBox(win, {
        message: candidate.state === 'installed' ? 'The latest tested update is already installed.' : 'No tested update is ready.',
        detail: candidate.state === 'installed' ? 'Run pnpm update:prepare after new changes to create another update.' : 'Run pnpm update:prepare, then choose Install Tested Update again.',
        buttons: ['OK'],
      })
      return
    }
    win.setProgressBar(2)
    await ensureDaemon()
    const { stdout } = await exec(python, [updater(), 'prepare', candidate.app, '--data', data,
      '--target', target, '--parent', String(process.pid)], { timeout: 180_000 })
    const jobPath = stdout.trim()
    const job = JSON.parse(readFileSync(jobPath, 'utf8'))
    const fd = openSync(join(data, 'updates/updater.log'), 'a')
    const worker = spawn(python, [join(job.app, 'Contents/Resources/helm-update.py'), 'run', jobPath], {
      detached: true, stdio: ['ignore', fd, fd],
    })
    closeSync(fd)
    let spawnError: Error | null = null
    worker.on('error', (error) => { spawnError = error })
    const ready = join(job.app, '../ready.json')
    for (let i = 0; i < 600; i++) {
      if (spawnError) throw spawnError
      if (worker.exitCode !== null) throw new Error('Updater failed. See updates/updater.log in the Helm data folder.')
      if (existsSync(ready)) {
        worker.unref()
        app.quit()
        return
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    worker.kill('SIGTERM')
    throw new Error('Updater did not become ready. Helm has stayed open.')
  } catch (error) {
    dialog.showErrorBox('Helm update could not start', String(error instanceof Error ? error.message : error))
  } finally {
    applying = false
    if (!win.isDestroyed()) win.setProgressBar(-1)
  }
}

export function showUpdateStatus(win: BrowserWindow, data: string) {
  let detail = 'No update has been applied yet. Build a candidate with pnpm update:prepare, then choose Install Tested Update… in the Helm menu.'
  const target = process.env.HELM_INSTALL_TARGET || join(homedir(), 'Applications/Helm Core.app')
  const candidate = candidateState(data, target)
  const readyLine = candidate.state === 'ready' ? `\n\nReady to install: build from ${new Date(candidate.createdAt!).toLocaleString()} (Install Tested Update… applies it in one click).` : candidate.state === 'installed' ? '\n\nThe latest tested update is already installed.' : '\n\nNo tested update is ready. Run pnpm update:prepare.'
  try {
    const status = JSON.parse(readFileSync(join(data, 'updates/latest.json'), 'utf8'))
    detail = `Last update: ${status.state}\n${status.error || 'Startup checks passed.'}\n\nBuild: ${status.id}\nPrevious app: ${status.previous || 'none'}\n\nDatabase backups and update logs: ${join(data, 'updates')}`
  } catch {}
  detail += readyLine
  void dialog.showMessageBox(win, { message: 'Helm updates', detail, buttons: ['OK'] })
}
