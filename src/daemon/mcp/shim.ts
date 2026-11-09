// Stdio MCP server that agents (Claude Code / Codex) load. Every call is proxied to the Helm daemon,
// which knows which session is calling via HELM_SESSION_ID.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { TOOLS } from './tools'

const URL_ = process.env.HELM_URL
const TOKEN = process.env.HELM_TOKEN
const SID = process.env.HELM_SESSION_ID || ''

async function api(path: string, body?: unknown) {
  const res = await fetch(`${URL_}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Helm-Session': SID },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(text || res.statusText)
  return text ? JSON.parse(text) : null
}

async function main() {
  let orchestrator = false
  try {
    const me = await api(`/mcp-api/context`)
    orchestrator = !!me?.orchestrator
  } catch {}

  const server = new Server({ name: 'helm', version: '0.1.0' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.filter((t) => orchestrator || !t.orchestratorOnly).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(t.input).map(([k, v]) => [k, { type: v.type, description: v.description, ...(v.enum ? { enum: v.enum } : {}) }]),
        ),
        required: Object.entries(t.input)
          .filter(([, v]) => !v.optional)
          .map(([k]) => k),
      },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await api(`/mcp-api/call/${req.params.name}`, req.params.arguments || {})
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Helm error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
    }
  })

  await server.connect(new StdioServerTransport())
}

main().catch((e) => {
  process.stderr.write(String(e))
  process.exit(1)
})
