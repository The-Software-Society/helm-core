import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { homedir } from 'node:os'
import { exposeElectronSpeech } from 'electron-native-speech/preload'

export interface Connection {
  url: string
  token: string
  build: string
  channel: string
  expectedBuild: string
}

const api = {
  home: homedir(),
  connection: (): Promise<Connection> => ipcRenderer.invoke('helm:connection'),
  uiReady: (): Promise<void> => ipcRenderer.invoke('helm:ui-ready'),
  restartDaemon: (): Promise<void> => ipcRenderer.invoke('helm:restart-daemon'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('helm:pick-folder'),
  openExternal: (url: string) => ipcRenderer.invoke('helm:open-external', url),
  reveal: (path: string) => ipcRenderer.invoke('helm:reveal', path),
  openPath: (path: string) => ipcRenderer.invoke('helm:open-path', path),
  copy: (text: string) => ipcRenderer.invoke('helm:clipboard', text),
  statPaths: (paths: string[]): Promise<{ path: string; exists: boolean; dir: boolean; size: number; mtime: number }[]> => ipcRenderer.invoke('helm:stat-paths', paths),
  readText: (path: string): Promise<{ text: string; binary: boolean; truncated: boolean; size: number }> => ipcRenderer.invoke('helm:read-text', path),
  copyImage: (path: string): Promise<boolean> => ipcRenderer.invoke('helm:copy-image', path),
  copyFile: (path: string): Promise<void> => ipcRenderer.invoke('helm:copy-file', path),
  quickLook: (path: string): Promise<void> => ipcRenderer.invoke('helm:quick-look', path),
  // Dropped files have no path in the page (File.path is gone in modern Electron); this is the supported way to get it.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('helm:pick-files'),
  saveAttachment: (name: string, bytes: ArrayBuffer): Promise<string> => ipcRenderer.invoke('helm:save-attachment', name, bytes),
  setBadge: (n: number) => ipcRenderer.send('helm:badge', n),
  onCommand: (cb: (cmd: string) => void) => {
    const h = (_: unknown, cmd: string) => cb(cmd)
    ipcRenderer.on('helm:command', h)
    return () => ipcRenderer.off('helm:command', h)
  },
  onDaemonRestarted: (cb: () => void) => {
    const h = () => cb()
    ipcRenderer.on('helm:daemon-restarted', h)
    return () => ipcRenderer.off('helm:daemon-restarted', h)
  },
}

export type HelmBridge = typeof api
contextBridge.exposeInMainWorld('helm', api)
exposeElectronSpeech()
