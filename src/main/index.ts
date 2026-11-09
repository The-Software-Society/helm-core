import { app, BrowserWindow, dialog, ipcMain, Menu, shell, clipboard, nativeTheme, screen } from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, watch, existsSync, realpathSync, copyFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { backupWorkspace, installTestedUpdate, showUpdateStatus } from './updates'
import { registerSpeechHandlers } from 'electron-native-speech/main-handlers'
import { registerFileHandlers, registerFileScheme } from './files'

const STABLE_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'Helm Core')
const IS_DEV = !app.isPackaged || process.env.HELM_CHANNEL === 'dev'
const requestedData = resolve(process.env.HELM_DATA_DIR || (IS_DEV ? `${STABLE_DATA_DIR} Dev` : STABLE_DATA_DIR))
const DATA_DIR = existsSync(requestedData) ? realpathSync(requestedData) : requestedData
if (IS_DEV && DATA_DIR === STABLE_DATA_DIR) throw new Error('Helm Dev must use a separate data directory')
process.env.HELM_DATA_DIR = DATA_DIR
process.env.HELM_CHANNEL = IS_DEV ? 'dev' : 'stable'
const APP_NAME = IS_DEV ? 'Helm Core Dev' : 'Helm Core'
const DAEMON_FILE = join(DATA_DIR, 'daemon.json')
const WINDOW_FILE = join(DATA_DIR, 'window.json')
const DAEMON_JS = realpathSync(join(__dirname, 'daemon.js'))

app.setName(APP_NAME)
// Isolated QA data must never overwrite the real workspace layout or contend for its UI lock.
if (DATA_DIR !== STABLE_DATA_DIR) {
  mkdirSync(join(DATA_DIR, 'ui'), { recursive: true })
  app.setPath('userData', join(DATA_DIR, 'ui'))
}
if (!app.requestSingleInstanceLock()) app.exit(0)
registerFileScheme()
app.on('second-instance', () => {
  if (!win) { if (app.isReady()) createWindow(); return }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})
nativeTheme.themeSource = 'dark'

interface DaemonInfo {
  port: number
  token: string
  pid: number
  build: string
  runtimePath?: string
  executable?: string
  /** The service keeps terminals in helm-ptyhost, so restarting it leaves them running. */
  terminalHost?: boolean
}

let win: BrowserWindow | null = null
let daemon: DaemonInfo | null = null

function readDaemonFile(): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(DAEMON_FILE, 'utf8'))
  } catch {
    return null
  }
}

async function healthy(info: DaemonInfo | null): Promise<boolean> {
  if (!info) return false
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/status`, { headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(1500) })
    return res.ok && (await res.json()).pid === info.pid
  } catch {
    return false
  }
}

function currentBuild() {
  try {
    return createHash('sha1').update(readFileSync(DAEMON_JS)).digest('hex').slice(0, 12)
  } catch {
    return ''
  }
}

function spawnDaemon(previous?: { executable: string; runtimePath: string }) {
  mkdirSync(DATA_DIR, { recursive: true })
  // Use the helper's bundle identity: LaunchServices must not mistake the daemon for the UI.
  const helper = join(process.resourcesPath, '../Frameworks/Helm Core Helper.app/Contents/MacOS/Helm Core Helper')
  const executable = realpathSync(app.isPackaged && existsSync(helper) ? helper : process.execPath)
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete env.HELM_UPDATE_RECEIPT
  delete env.HELM_REQUIRE_DAEMON
  const child = spawn(previous?.executable || executable, [previous?.runtimePath || DAEMON_JS], {
    env,
    detached: true,
    stdio: 'ignore',
  })
  if (child.pid) writeFileSync(join(DATA_DIR, 'starting-service.json'), JSON.stringify({ pid: child.pid, runtimePath: previous?.runtimePath || DAEMON_JS }))
  child.on('error', () => {}) // waitForDaemon reports a bounded startup failure
  child.unref()
  return child
}

async function waitForDaemon(prevPid?: number, timeoutMs = 20_000): Promise<DaemonInfo> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const info = readDaemonFile()
    if (info && info.pid !== prevPid && (await healthy(info))) return info
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('Helm daemon did not start. See ~/Library/Application Support/Helm Core/hubd.log')
}

// Serialize daemon lifecycle so a reload mid-restart can't spawn a second daemon.
let lifecycle: Promise<DaemonInfo> | null = null
function serialized(fn: () => Promise<DaemonInfo>): Promise<DaemonInfo> {
  if (lifecycle) return lifecycle
  lifecycle = fn().finally(() => (lifecycle = null))
  return lifecycle
}

function ensureDaemon(): Promise<DaemonInfo> {
  return serialized(async () => {
    const info = readDaemonFile()
    if (await healthy(info)) return info!
    if (process.env.HELM_REQUIRE_DAEMON) throw new Error('The existing terminal service is unavailable. The update will roll back.')
    spawnDaemon()
    return waitForDaemon(info?.pid)
  })
}

function restartDaemon(): Promise<DaemonInfo> {
  return serialized(restartDaemonNow)
}

async function restartDaemonNow(): Promise<DaemonInfo> {
  const info = readDaemonFile()
  await backupWorkspace(DATA_DIR)
  if (info?.pid && await healthy(info)) {
    try {
      process.kill(info.pid, 'SIGTERM')
    } catch {}
    const t = Date.now()
    while (Date.now() - t < 5000) {
      try {
        process.kill(info.pid, 0)
        await new Promise((r) => setTimeout(r, 100))
      } catch {
        break
      }
    }
  }
  if (info?.pid) {
    try { process.kill(info.pid, 0); throw new Error('The previous service is still running. No replacement was started.') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  // Take the rollback snapshot after shutdown so its final terminal checkpoints are included.
  const backup = await backupWorkspace(DATA_DIR)
  const child = spawnDaemon()
  try {
    daemon = await waitForDaemon(info?.pid)
  } catch (error) {
    child.kill('SIGTERM')
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await new Promise((r) => setTimeout(r, 100))
    if (child.exitCode === null && child.signalCode === null) throw new Error('New service did not stop. Restore was deferred to protect the database.')
    if (existsSync(backup)) {
      for (const suffix of ['-wal', '-shm']) {
        try { unlinkSync(join(DATA_DIR, `helm.db${suffix}`)) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      }
      copyFileSync(backup, join(DATA_DIR, 'helm.db'))
    }
    let previous = info?.runtimePath && info.executable ? { runtimePath: info.runtimePath, executable: info.executable } : null
    if (!previous) {
      try {
        const oldApp = JSON.parse(readFileSync(join(DATA_DIR, 'updates/latest.json'), 'utf8')).previous
        if (oldApp) previous = {
          runtimePath: join(oldApp, 'Contents/Resources/app/out/main/daemon.js'),
          executable: join(oldApp, 'Contents/Frameworks/Helm Core Helper.app/Contents/MacOS/Helm Core Helper'),
        }
      } catch {}
    }
    if (previous && existsSync(previous.runtimePath) && existsSync(previous.executable)) {
      spawnDaemon(previous)
      daemon = await waitForDaemon(info?.pid)
      win?.webContents.send('helm:daemon-restarted', daemon)
    }
    throw error
  }
  win?.webContents.send('helm:daemon-restarted', daemon)
  return daemon
}

function loadBounds() {
  try {
    const b = JSON.parse(readFileSync(WINDOW_FILE, 'utf8'))
    const visible = screen.getAllDisplays().some((d) => b.x >= d.bounds.x - 50 && b.y >= d.bounds.y - 50 && b.x < d.bounds.x + d.bounds.width)
    return visible ? b : null
  } catch {
    return null
  }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return
  try {
    writeFileSync(WINDOW_FILE, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }))
  } catch {}
}

function createWindow() {
  const b = loadBounds()
  win = new BrowserWindow({
    width: b?.width || 1560,
    height: b?.height || 980,
    x: b?.x,
    y: b?.y,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#07051a',
    title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      spellcheck: false,
    },
  })
  if (b?.maximized) win.maximize()
  const cleanupSpeech = registerSpeechHandlers(ipcMain, win.webContents)
  win.on('page-title-updated', (event) => { event.preventDefault(); win?.setTitle(APP_NAME) })
  win.once('ready-to-show', () => win?.show())
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('close', saveBounds)
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    // A file dropped anywhere outside a drop target would otherwise replace the app with that file.
    if (url.startsWith('file://') && !url.includes('/renderer/index.html')) {
      e.preventDefault()
      return
    }
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) {
      e.preventDefault()
      void shell.openExternal(url)
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => { cleanupSpeech(); win = null })
}

const send = (cmd: string) => () => win?.webContents.send('helm:command', cmd)

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: send('settings') },
        { type: 'separator' },
        { label: 'Install Tested Update', enabled: !IS_DEV && (DATA_DIR === STABLE_DATA_DIR || !!process.env.HELM_INSTALL_TARGET), click: () => win && void installTestedUpdate(win, DATA_DIR, ensureDaemon) },
        { label: 'Update Status…', click: () => win && showUpdateStatus(win, DATA_DIR) },
        { label: 'Restart Background Service…', click: () => void confirmRestartDaemon() },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { label: 'Quit Helm (agents keep running)', accelerator: 'Cmd+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open Project…', accelerator: 'Cmd+O', click: send('open-project') },
        { label: 'New Session', accelerator: 'Cmd+T', click: send('new-session') },
        { label: 'New Shell', accelerator: 'Cmd+Shift+T', click: send('new-shell') },
        { label: 'Close Session', accelerator: 'Cmd+W', click: send('close-session') },
        { type: 'separator' },
        { label: 'Command Palette', accelerator: 'Cmd+K', click: send('palette') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Home', accelerator: 'Cmd+Shift+H', click: send('home') },
        { label: 'Needs You', accelerator: 'Cmd+Shift+N', click: send('needs-you') },
        { label: 'Reviews', accelerator: 'Cmd+Shift+R', click: send('reviews') },
        { label: 'Insights', accelerator: 'Cmd+Shift+Y', click: send('insights') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'Cmd+B', click: send('toggle-sidebar') },
        { label: 'Split Terminal', accelerator: 'Cmd+D', click: send('split') },
        { label: 'Next Needs-You', accelerator: 'Cmd+J', click: send('next-attention') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function confirmRestartDaemon() {
  const keeps = !!readDaemonFile()?.terminalHost
  const result = await dialog.showMessageBox(win!, {
    type: keeps ? 'question' : 'warning', message: 'Restart Helm’s background service?',
    detail: keeps
      ? 'Terminals and agents keep running and reconnect when the service is back, usually within a few seconds. Background jobs in progress (syncs, AI reviews) restart. A database backup is saved first.'
      : 'This stops all running project terminals and background jobs, including any agent updating Helm. A database backup is saved first. Use Resume workspace afterward to restore agent conversations; shell commands are not replayed. This is the last restart that stops terminals: the new service keeps them running across restarts.',
    buttons: ['Restart service', 'Cancel'], defaultId: 1, cancelId: 1,
  })
  if (result.response !== 0) return
  try { await restartDaemon() }
  catch (error) { dialog.showErrorBox('Service restart failed', `${String(error)}\nDatabase backups are in ${join(DATA_DIR, 'backups')}.`) }
}

ipcMain.handle('helm:ui-ready', async () => {
  if (!process.env.HELM_UPDATE_RECEIPT || !daemon || !(await healthy(daemon))) return
  writeFileSync(process.env.HELM_UPDATE_RECEIPT, JSON.stringify({
    pid: process.pid, daemonPid: daemon.pid, app: realpathSync(join(app.getAppPath(), '../../..')),
  }))
  delete process.env.HELM_REQUIRE_DAEMON
})

ipcMain.handle('helm:connection', async () => {
  daemon = daemon && (await healthy(daemon)) ? daemon : await ensureDaemon()
  return { url: `http://127.0.0.1:${daemon.port}`, token: daemon.token, build: daemon.build, expectedBuild: currentBuild(), channel: IS_DEV ? 'dev' : 'stable' }
})
ipcMain.handle('helm:restart-daemon', () => confirmRestartDaemon())
ipcMain.handle('helm:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], defaultPath: join(homedir(), 'Developer') })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('helm:open-external', (_e, url: string) => shell.openExternal(url))
ipcMain.handle('helm:reveal', (_e, path: string) => shell.showItemInFolder(path))
ipcMain.handle('helm:open-path', (_e, path: string) => shell.openPath(path))
ipcMain.handle('helm:clipboard', (_e, text: string) => clipboard.writeText(text))
ipcMain.on('helm:badge', (_e, n: number) => app.dock?.setBadge(n > 0 ? String(n) : ''))

// Dev-only UI driver: write JS to $HELM_DEBUG_DIR/cmd.js → it runs in the renderer, then shot.png is captured.
function startDebugDriver() {
  const dir = process.env.HELM_DEBUG_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const cmd = join(dir, 'cmd.js')
  if (!existsSync(cmd)) writeFileSync(cmd, '')
  let busy = false
  watch(cmd, async () => {
    if (busy || !win) return
    busy = true
    try {
      const code = readFileSync(cmd, 'utf8')
      let result: unknown = null
      if (code.trim()) result = await win.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
      await new Promise((r) => setTimeout(r, Number(process.env.HELM_DEBUG_DELAY) || 900))
      const img = await win.webContents.capturePage()
      writeFileSync(join(dir, 'shot.png'), img.toPNG())
      writeFileSync(join(dir, 'result.json'), JSON.stringify({ at: Date.now(), result }))
    } catch (e) {
      writeFileSync(join(dir, 'result.json'), JSON.stringify({ at: Date.now(), error: String(e) }))
    } finally {
      busy = false
    }
  })
}

app.whenReady().then(async () => {
  buildMenu()
  registerFileHandlers(() => win)
  try {
    daemon = await ensureDaemon()
  } catch (e) {
    dialog.showErrorBox('Helm', e instanceof Error ? e.message : String(e))
  }
  createWindow()
  startDebugDriver()
  app.on('activate', () => {
    if (!win) createWindow()
  })
})

// Closing the window keeps Helm (and its daemon) alive in the dock, like a native Mac app.
app.on('window-all-closed', () => {})
