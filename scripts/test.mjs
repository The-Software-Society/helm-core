import { build } from 'vite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const pkg = require('../package.json')
const scratch = mkdtempSync(join(tmpdir(), 'helm-tests-'))
try {
  await build({
    configFile: false, logLevel: 'warn',
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { ssr: true, outDir: 'out/tests', emptyOutDir: true,
      rollupOptions: { input: { regression: 'src/daemon/regression.test.ts', ptyhost: 'src/daemon/ptyhost/host.ts' },
        external: [...Object.keys(pkg.dependencies), /^node:/, /^@modelcontextprotocol\/sdk\//], output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  })
  const result = spawnSync(require('electron'), ['--test', 'out/tests/regression.cjs'], {
    stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HELM_DATA_DIR: scratch, CODEX_HOME: join(scratch, 'codex'), QWEN_HOME: join(scratch, 'qwen') },
  })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync('out/tests', { recursive: true, force: true })
}
