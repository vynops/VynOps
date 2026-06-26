'use client'

import { useState, useEffect, useRef } from 'react'
import { X, Edit3, Save, AlertTriangle, Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getClusterHeaders } from '@/store'

interface YamlViewerProps {
  kind: string
  namespace: string
  name: string
  onClose: () => void
}

function syntaxHighlight(json: string): string {
  return json
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, match => {
      let cls = 'text-surface-300' // number
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'text-brand-300' : 'text-amber-300' // key vs value
      } else if (/true|false/.test(match)) {
        cls = 'text-success'
      } else if (/null/.test(match)) {
        cls = 'text-surface-500'
      }
      return `<span class="${cls}">${match}</span>`
    })
}

export function YamlViewer({ kind, namespace, name, onClose }: YamlViewerProps) {
  const [yaml, setYaml] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<'ok' | 'error' | null>(null)
  const [copied, setCopied] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const params = new URLSearchParams({ kind, namespace, name })
    fetch(`/api/k8s/yaml?${params}`, { headers: getClusterHeaders() })
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError(j.error); return }
        setYaml(j.yaml)
        setEditContent(j.yaml)
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [kind, namespace, name])

  const handleSave = async () => {
    setSaving(true)
    setSaveResult(null)
    try {
      JSON.parse(editContent) // validate
    } catch {
      setSaveResult('error')
      setSaving(false)
      return
    }
    const params = new URLSearchParams({ kind, namespace, name })
    const r = await fetch(`/api/k8s/yaml?${params}`, { method: 'PATCH', body: editContent, headers: { 'Content-Type': 'application/json', ...getClusterHeaders() } })
    const j = await r.json()
    setSaveResult(j.ok ? 'ok' : 'error')
    if (j.ok) { setYaml(editContent); setEditing(false) }
    setSaving(false)
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(yaml)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="fixed inset-y-0 right-0 w-[600px] bg-surface-950 border-l border-surface-700 z-50 flex flex-col shadow-2xl">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-surface-800">
        <div>
          <h3 className="text-sm font-bold text-white">{kind}: <span className="font-mono text-brand-300">{name}</span></h3>
          {namespace && <p className="text-2xs text-surface-500 mt-0.5">namespace: {namespace}</p>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleCopy} className="flex items-center gap-1 text-2xs text-surface-400 hover:text-white px-2 py-1 rounded bg-surface-800 hover:bg-surface-700">
            {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />} Copy
          </button>
          {!editing ? (
            <button onClick={() => setEditing(true)} className="flex items-center gap-1 text-2xs text-brand-400 hover:text-brand-300 px-2 py-1 rounded bg-brand-500/10 hover:bg-brand-500/20">
              <Edit3 className="w-3 h-3" /> Edit
            </button>
          ) : (
            <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 text-2xs text-white px-2 py-1 rounded bg-brand-500 hover:bg-brand-600 disabled:opacity-40">
              <Save className="w-3 h-3" /> {saving ? 'Saving…' : 'Apply'}
            </button>
          )}
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-700 text-surface-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {editing && kind === 'Pod' && (
        <div className="px-5 py-2 text-xs flex items-center gap-2 bg-warning/10 text-warning border-b border-warning/20">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          Pods are mostly immutable. Edit the owning Deployment or StatefulSet instead — only labels/annotations typically apply.
        </div>
      )}

      {saveResult && (
        <div className={cn('px-5 py-2 text-xs flex items-center gap-2', saveResult === 'ok' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger')}>
          <AlertTriangle className="w-3.5 h-3.5" />
          {saveResult === 'ok' ? 'Applied successfully' : 'Failed to apply — check JSON validity and K8s permissions'}
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        {loading && <div className="flex items-center justify-center h-full text-surface-500 text-sm">Loading manifest…</div>}
        {error && <div className="flex items-center justify-center h-full text-danger text-sm px-8 text-center">{error}</div>}
        {!loading && !error && (
          editing ? (
            <textarea
              ref={textareaRef}
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              className="w-full h-full bg-surface-950 font-mono text-xs text-surface-200 p-4 resize-none outline-none border-none"
              spellCheck={false}
            />
          ) : (
            <pre
              className="w-full h-full overflow-auto p-4 font-mono text-xs leading-relaxed"
              dangerouslySetInnerHTML={{ __html: syntaxHighlight(yaml) }}
            />
          )
        )}
      </div>
    </div>
  )
}
