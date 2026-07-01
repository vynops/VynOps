/**
 * VynOps custom Next.js server
 * Adds WebSocket proxy for /api/k8s/exec → kubectl proxy → K8s exec API
 *
 * Run from d:\vynops-ai\apps\web:
 *   node server.mjs
 */

import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { WebSocketServer, WebSocket as WS } from 'ws'

process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err.message, err.stack)
  // Do NOT exit — keep the server alive for non-fatal errors
})
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason)
})

// ── Autonomous loop cron secret ──────────────────────────────────────────────
// Shared between server.mjs (caller) and the Next.js API route (receiver).
// Set CRON_SECRET env var to lock it down; otherwise a random secret is
// generated at startup and lives only for the lifetime of this process.
if (!process.env.CRON_SECRET) {
  process.env.CRON_SECRET = 'vynops-cron-' + crypto.randomUUID().replace(/-/g, '')
}
const CRON_SECRET = process.env.CRON_SECRET

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOST || '0.0.0.0'
const port = parseInt(process.env.PORT || '3030', 10)

// kubectl proxy URL — override with KUBECTL_PROXY_URL env var if needed
const KUBECTL_PROXY = (process.env.KUBECTL_PROXY_URL || 'http://127.0.0.1:8001')
  .replace(/\/$/, '')

// Own public/LAN IPs this server is reachable on — any cluster URL pointing at
// these will be rewritten to 127.0.0.1 so exec WebSocket stays on loopback.
const OWN_IPS = (process.env.OWN_IPS || '')
  .split(',').map(s => s.trim()).filter(Boolean)

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()
const wss = new WebSocketServer({ noServer: true })

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true)
      await handle(req, res, parsedUrl)
    } catch (err) {
      console.error('[server] Request handler error:', err)
      res.statusCode = 500
      res.end('Internal Server Error')
    }
  })

  // Use prependListener so our handler fires BEFORE Next.js's internal HMR
  // upgrade listener (which would otherwise destroy the socket for unknown paths)
  server.prependListener('upgrade', (req, socket, head) => {
    const { pathname, query } = parse(req.url, true)

    if (pathname === '/api/k8s/exec') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        /**
         * CRITICAL FIX: After wss.handleUpgrade sends the 101 Switching Protocols
         * response, Next.js's internal HMR upgrade listener may still fire and call
         * socket.destroy() or socket.end() on the now-upgraded socket, killing the
         * WebSocket connection (browser sees code 1006).
         *
         * Solution: patch socket.destroy / socket.end to no-ops until the WebSocket
         * closes normally. The ws library uses socket.write() for frames, so that
         * is NOT patched.
         */
        const origDestroy = socket.destroy.bind(socket)
        const origEnd = socket.end.bind(socket)

        socket.destroy = (err) => {
          // Allow the ws library's own teardown (it passes an Error on protocol errors)
          // Block external callers (Next.js HMR) which call destroy() with no args
          if (err) origDestroy(err)
          // else: silently drop — ws library will handle close via its own path
        }
        socket.end = (...args) => {
          // Block premature end calls; ws library closes via socket.destroy on error
          // or by sending the WebSocket close frame and letting the peer close.
        }

        ws.on('close', () => {
          // Restore original methods after the WebSocket session ends
          socket.destroy = origDestroy
          socket.end = origEnd
        })

        handleExec(ws, query)
      })
    }
    // For all other upgrade requests (Next.js HMR, etc.) — do nothing, let the
    // default Next.js upgrade listener handle them.
  })

  server.listen(port, hostname, () => {
    console.log(`> VynOps ready on http://${hostname}:${port}`)

    // ── Server-side autonomous healing loop ───────────────────────────────────
    // Fires every 5 minutes regardless of whether any browser tab is open.
    // The browser hook (useAutonomousLoop) is additive — both can fire safely
    // because the loop's per-workload cooldown prevents duplicate actions.
    const LOOP_MS  = 5 * 60 * 1000
    const loopBase = `http://localhost:${port}`

    const runAutonomousLoop = () => {
      fetch(`${loopBase}/api/autonomous/loop`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${CRON_SECRET}`,
        },
      })
        .then(r => r.json())
        .then(d => {
          if (d.skipped) return // autonomous disabled — silent
          console.log(
            `[cron] autonomous loop — ok:${d.actionsOk ?? 0}` +
            ` dry:${d.actionsDryRun ?? 0}` +
            ` cooldown:${d.actionsCooldown ?? 0}` +
            ` verified:${d.verificationsRun ?? 0}`,
          )
        })
        .catch(e => console.error('[cron] autonomous loop error:', e.message))
    }

    setTimeout(runAutonomousLoop, 60_000)        // first run: 1 min after boot
    setInterval(runAutonomousLoop, LOOP_MS)       // then every 5 min
  })
})

/**
 * Proxy a client WebSocket to the K8s exec endpoint via kubectl proxy.
 *
 * K8s exec WebSocket protocol (remotecommand/v4):
 *   - Each message is binary; byte[0] is the channel:
 *       0 = stdin   (client → k8s)
 *       1 = stdout  (k8s → client)
 *       2 = stderr  (k8s → client)
 *       3 = error   (k8s → client, JSON)
 *       4 = resize  (client → k8s, JSON {Width, Height})
 *
 * The browser client sends plain UTF-8 text. The server prepends channel byte 0
 * and forwards as binary. The server strips channel bytes from K8s output and
 * forwards stdout/stderr as UTF-8 text strings to the browser.
 */
function handleExec(clientWs, query) {
  const { namespace, pod, container, command, k8sUrl: clusterUrl } = query
  if (!namespace || !pod) {
    clientWs.close(1008, 'namespace and pod are required')
    return
  }

  const cmd = command || '/bin/sh'

  // Use per-request cluster URL if provided (multi-cluster support), else default.
  // Rewrite any URL pointing at this server's own public IP to 127.0.0.1 so
  // the exec WebSocket reaches kubectl proxy on loopback (avoids hairpin NAT issues).
  let rawProxyHost = (clusterUrl && clusterUrl.startsWith('http'))
    ? clusterUrl.replace(/\/$/, '')
    : KUBECTL_PROXY
  for (const ip of OWN_IPS) {
    rawProxyHost = rawProxyHost.replace(ip, '127.0.0.1')
  }
  const proxyHost = rawProxyHost
  const proxyBase = proxyHost.replace(/^http/, 'ws')
  const k8sUrl =
    `${proxyBase}/api/v1/namespaces/${encodeURIComponent(namespace)}` +
    `/pods/${encodeURIComponent(pod)}/exec` +
    `?stdin=true&stdout=true&stderr=true&tty=true` +
    `&command=${encodeURIComponent(cmd)}` +
    (container ? `&container=${encodeURIComponent(container)}` : '')

  const label = `${namespace}/${pod}${container ? `/${container}` : ''}`
  console.log(`[exec] → ${label} (${cmd})`)

  const k8sWs = new WS(k8sUrl, ['channel.k8s.io'])

  // ── Error handlers ──────────────────────────────────────────────────────────
  clientWs.on('error', (err) => {
    console.error(`[exec] Client WS error (${pod}):`, err.message)
  })

  k8sWs.on('error', (err) => {
    console.error(`[exec] K8s WS error (${pod}):`, err.message)
  })

  // ── K8s → Client ────────────────────────────────────────────────────────────
  k8sWs.on('open', () => {
    console.log(`[exec] K8s WS connected: ${label}`)
  })

  k8sWs.on('message', (data) => {
    if (clientWs.readyState !== WS.OPEN) return

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (buf.length === 0) return

    const channel = buf[0]
    if (channel === 1 || channel === 2) {
      // stdout or stderr — forward as UTF-8 text to browser
      const text = buf.slice(1).toString('utf8')
      if (text) clientWs.send(text)
    } else if (channel === 3) {
      // K8s error channel — log and surface to browser
      const errText = buf.slice(1).toString('utf8')
      console.error(`[exec] K8s error channel (${pod}):`, errText)
      if (clientWs.readyState === WS.OPEN) {
        try {
          const parsed = JSON.parse(errText)
          if (parsed?.message) clientWs.send(`[error] ${parsed.message}`)
        } catch {
          clientWs.send(`[error] ${errText}`)
        }
      }
    }
    // channel 0 = stdin echo (ignore), channel 4 = resize ack (ignore)
  })

  k8sWs.on('close', (code, reason) => {
    const r = Buffer.isBuffer(reason) ? reason.toString() : String(reason || '')
    console.log(`[exec] K8s WS closed (${pod}) code=${code}${r ? ` reason=${r}` : ''}`)
    if (clientWs.readyState === WS.OPEN) {
      clientWs.close(1000, 'k8s connection closed')
    }
  })

  // ── Client → K8s ────────────────────────────────────────────────────────────
  clientWs.on('message', (data) => {
    if (k8sWs.readyState !== WS.OPEN) return

    // Browser sends plain text; prepend stdin channel byte (0x00)
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    if (!text) return

    const payload = Buffer.allocUnsafe(text.length + 1)
    payload[0] = 0x00 // stdin channel
    payload.write(text, 1, 'utf8')
    k8sWs.send(payload)
  })

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  clientWs.on('close', () => {
    if (k8sWs.readyState !== WS.CLOSED && k8sWs.readyState !== WS.CLOSING) {
      k8sWs.terminate()
    }
  })
}
