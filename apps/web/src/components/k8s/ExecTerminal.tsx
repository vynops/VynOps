'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Terminal, Send, RotateCcw, Zap } from 'lucide-react'
import { getClusterHeaders } from '@/store'

interface ExecTerminalProps {
  namespace: string
  pod: string
  container?: string
  onClose: () => void
}

type LineEntry = { text: string; type: 'output' | 'input' | 'system' }

/** Strip ANSI escape sequences so terminal output renders cleanly */
function stripAnsi(s: string) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '')
}

export function ExecTerminal({ namespace, pod, container, onClose }: ExecTerminalProps) {
  const [lines, setLines] = useState<LineEntry[]>([])
  const [input, setInput] = useState('')
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(true)
  const [reconnectKey, setReconnectKey] = useState(0)
  const [shellCmd, setShellCmd] = useState('/bin/sh')
  const wsRef = useRef<WebSocket | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const bufRef = useRef('')        // partial-line buffer (prompts have no trailing \n)
  const shellCmdRef = useRef('/bin/sh')

  const appendLine = useCallback((text: string, type: LineEntry['type'] = 'output') => {
    setLines(prev => [...prev, { text, type }])
  }, [])

  useEffect(() => {
    let cancelled = false
    const cmd = shellCmdRef.current

    setConnecting(true)
    setConnected(false)
    setLines([{ text: `Connecting to ${pod}${container ? `/${container}` : ''} (${cmd})…`, type: 'system' }])
    bufRef.current = ''

    const clusterHeaders = getClusterHeaders()
    const k8sUrl = clusterHeaders['X-K8s-Url']
    const params = new URLSearchParams({ namespace, pod, command: cmd })
    if (container) params.set('container', container)
    if (k8sUrl && k8sUrl !== 'none') params.set('k8sUrl', k8sUrl)
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/k8s/exec?${params}`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      if (cancelled) { ws.close(); return }
      setConnecting(false)
      setConnected(true)
      appendLine('Connected.', 'system')
    }

    ws.onmessage = (e) => {
      if (cancelled || typeof e.data !== 'string') return
      // Ignore server control messages (e.g. {"type":"connected"})
      try { const m = JSON.parse(e.data); if (m?.type === 'connected') return } catch { /* raw */ }
      // Normalize line endings, strip ANSI
      const text = stripAnsi(e.data).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      bufRef.current += text
      const parts = bufRef.current.split('\n')
      bufRef.current = parts.pop() ?? ''
      for (const line of parts) appendLine(line)
      // Flush immediately if it looks like a shell prompt (ends with $ / # / > )
      if (bufRef.current && /[$#>]\s*$/.test(bufRef.current)) {
        appendLine(bufRef.current)
        bufRef.current = ''
      }
    }

    ws.onerror = () => {
      if (cancelled) return
      setConnecting(false)
      setConnected(false)
      appendLine('WebSocket error — check server logs and kubectl proxy', 'system')
    }

    ws.onclose = (e) => {
      if (cancelled) return
      setConnected(false)
      setConnecting(false)
      appendLine(`Connection closed${e.code !== 1000 ? ` (code ${e.code})` : ''}.`, 'system')
    }

    return () => {
      cancelled = true
      wsRef.current = null
      // If already OPEN close it now; if still CONNECTING let onopen handle it
      // (calling ws.close() while CONNECTING produces a noisy browser warning)
      if (ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
      bufRef.current = ''
    }
  // appendLine is stable (useCallback []); exclude to avoid phantom re-runs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, pod, container, reconnectKey])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  const sendCommand = () => {
    if (!input.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    appendLine(`$ ${input}`, 'input')
    wsRef.current.send(input + '\n')
    setInput('')
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') sendCommand()
    else if (e.key === 'c' && e.ctrlKey) {
      wsRef.current?.send('\x03')
      appendLine('^C', 'input')
    }
  }

  const reconnect = () => {
    shellCmdRef.current = shellCmd
    setReconnectKey(k => k + 1)
  }

  return (
    <div className="fixed inset-y-0 right-0 w-[560px] bg-[#0d1117] border-l border-surface-700 z-50 flex flex-col shadow-2xl font-mono">
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-800 bg-surface-950">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-success" />
          <span className="text-sm font-semibold text-white">{pod}</span>
          {container && <span className="text-2xs text-surface-500 bg-surface-800 px-1.5 py-0.5 rounded">{container}</span>}
          <span className={`text-2xs px-1.5 py-0.5 rounded ${connected ? 'bg-success/10 text-success' : connecting ? 'bg-warning/10 text-warning' : 'bg-danger/10 text-danger'}`}>
            {connected ? 'connected' : connecting ? 'connecting…' : 'disconnected'}
          </span>
        </div>
        <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-700 text-surface-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 text-xs leading-relaxed space-y-0.5">
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              line.type === 'input' ? 'text-blue-300' :
              line.type === 'system' ? 'text-surface-500 italic' :
              'text-[#e6edf3]'
            }
          >
            {line.text || '\u00A0'}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Sample commands — shown when connected */}
      {connected && (
        <div className="border-t border-surface-800 px-3 py-2 flex items-center gap-1.5 flex-wrap">
          <Zap className="w-3 h-3 text-surface-600 flex-shrink-0" />
          {[
            { label: 'ls -la', cmd: 'ls -la' },
            { label: 'ps aux', cmd: 'ps aux' },
            { label: 'env', cmd: 'env' },
            { label: 'df -h', cmd: 'df -h' },
            { label: 'cat /etc/os-release', cmd: 'cat /etc/os-release' },
            { label: 'netstat', cmd: 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null' },
          ].map(({ label, cmd }) => (
            <button key={label}
              onClick={() => {
                if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
                appendLine(`$ ${cmd}`, 'input')
                wsRef.current.send(cmd + '\n')
              }}
              className="px-2 py-0.5 text-2xs bg-surface-800 hover:bg-surface-700 border border-surface-700 hover:border-brand-500/50 text-surface-400 hover:text-white rounded transition-all">
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Reconnect bar — shown only when disconnected */}
      {!connected && !connecting && (
        <div className="border-t border-surface-800 px-3 py-2 flex items-center gap-2">
          <input
            value={shellCmd}
            onChange={e => setShellCmd(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && reconnect()}
            placeholder="/bin/sh"
            className="flex-1 bg-surface-900 border border-surface-700 rounded px-2 py-1 text-xs text-white outline-none"
          />
          <button onClick={reconnect}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded">
            <RotateCcw className="w-3 h-3" /> Reconnect
          </button>
        </div>
      )}

      <div className="border-t border-surface-800 px-3 py-2 flex items-center gap-2">
        <span className="text-green-400 text-xs">$</span>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={!connected}
          placeholder={connected ? 'type command, Enter to send, Ctrl+C to interrupt' : 'not connected'}
          className="flex-1 bg-transparent text-xs text-white outline-none placeholder-surface-600 disabled:opacity-40"
          autoFocus
        />
        <button onClick={sendCommand} disabled={!connected || !input.trim()}
          className="w-6 h-6 flex items-center justify-center text-surface-500 hover:text-green-400 disabled:opacity-30">
          <Send className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}
