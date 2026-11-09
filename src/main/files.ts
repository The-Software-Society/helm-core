import { BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, protocol } from 'electron'
import { createReadStream, statSync } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'

// Local file viewer plumbing: the renderer shows files the user ⌘-clicks in a terminal. `helm-file://local/<path>` streams
// any regular file with Range support (so videos seek); the IPC handlers stat, read text, copy images, and Quick Look.

const SCHEME = 'helm-file'
const TEXT_LIMIT = 2 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
}

/** Must run before app ready. */
export function registerFileScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }])
}

function serve(req: Request): Response {
  const path = decodeURIComponent(new URL(req.url).pathname)
  let size: number
  try {
    const st = statSync(path)
    if (!st.isFile()) return new Response(null, { status: 404 })
    size = st.size
  } catch {
    return new Response(null, { status: 404 })
  }
  const type = MIME[extname(path).toLowerCase()] || 'application/octet-stream'
  const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
  const range = req.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/)
  if (range && size > 0) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : size - 1
    start = Math.max(0, start)
    end = Math.min(end, size - 1)
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
    return new Response(body, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } })
  }
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers: { ...headers, 'Content-Length': String(size) } })
}

export interface FileStat { path: string; exists: boolean; dir: boolean; size: number; mtime: number }

const stat = (path: string): FileStat => {
  try {
    const st = statSync(path)
    return { path, exists: true, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }
  } catch {
    return { path, exists: false, dir: false, size: 0, mtime: 0 }
  }
}

async function readText(path: string) {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const buf = Buffer.alloc(Math.min(size, TEXT_LIMIT))
    await fh.read(buf, 0, buf.length, 0)
    // NUL bytes in the first 8K ⇒ binary; don't render garbage.
    if (buf.subarray(0, 8192).includes(0)) return { text: '', binary: true, truncated: false, size }
    return { text: buf.toString('utf8'), binary: false, truncated: size > TEXT_LIMIT, size }
  } finally {
    await fh.close()
  }
}

export function registerFileHandlers(getWin: () => BrowserWindow | null) {
  protocol.handle(SCHEME, serve)
  ipcMain.handle('helm:stat-paths', (_e, paths: string[]) => paths.slice(0, 200).map(stat))
  ipcMain.handle('helm:read-text', (_e, path: string) => readText(path))
  ipcMain.handle('helm:copy-image', async (_e, path: string) => {
    const img = nativeImage.createFromPath(path)
    if (img.isEmpty()) return false
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })])
    return true
  })
  // Puts the file itself on the pasteboard, like ⌘C in Finder — paste into Slack, Mail, Messages.
  ipcMain.handle('helm:copy-file', (_e, path: string) =>
    clipboard.write([new ClipboardItem({ 'electron application/osclipboard;format="public.file-url"': pathToFileURL(path).href })]))
  ipcMain.handle('helm:quick-look', (_e, path: string) => getWin()?.previewFile(path))
  ipcMain.handle('helm:pick-files', async () => {
    const r = await dialog.showOpenDialog(getWin()!, { properties: ['openFile', 'openDirectory', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  // Pasted screenshots exist only in memory; give them a real file the agent can read (kept, so resumed sessions still can).
  ipcMain.handle('helm:save-attachment', async (_e, name: string, bytes: ArrayBuffer) => {
    const dir = join(process.env.HELM_DATA_DIR!, 'attachments', new Date().toISOString().slice(0, 10))
    await mkdir(dir, { recursive: true })
    const safe = basename(name).replace(/[^\w.\-]+/g, '-') || 'paste.png'
    const path = join(dir, `${Date.now().toString(36)}-${safe}`)
    await writeFile(path, Buffer.from(bytes))
    return path
  })
}
