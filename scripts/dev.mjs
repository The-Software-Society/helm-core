// Deliberately override inherited Helm variables when launched from a stable terminal.
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
const env = { ...process.env }
const debugDir = process.env.HELM_DEBUG_DIR
if (process.platform === 'darwin') {
  const plist = resolve('node_modules/electron/dist/Electron.app/Contents/Info.plist')
  for (const [key, description] of Object.entries({
    NSSpeechRecognitionUsageDescription: 'Helm Dev transcribes speech into prompts you can review before sending.',
    NSMicrophoneUsageDescription: 'Helm Dev uses the microphone when you choose to dictate a prompt.',
  })) execFileSync('plutil', ['-replace', key, '-string', description, plist])
}
for (const key of Object.keys(env)) if (key.startsWith('HELM_')) delete env[key]
env.HELM_CHANNEL = 'dev'
env.HELM_DATA_DIR = process.env.HELM_DEV_DATA_DIR || join(homedir(), 'Library/Application Support/Helm Core Dev')
if (debugDir) env.HELM_DEBUG_DIR = debugDir
const child = spawn(resolve('node_modules/.bin/electron-vite'), ['dev'], { env, stdio: 'inherit' })
child.on('error', (error) => { console.error(error); process.exitCode = 1 })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
