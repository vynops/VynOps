import { NextRequest, NextResponse } from 'next/server'
import { assertOperator } from '@/lib/rbac'
import { resolveK8sUrl } from '@/lib/cluster'


export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ namespace: string; name: string }> },
) {
  const K8S  = await resolveK8sUrl()
  const deny = await assertOperator()
  if (deny) return deny
  if (!K8S) return NextResponse.json({ ok: true, source: 'mock' })
  const { namespace, name } = await params

  try {
    // Fetch the CronJob to get its jobTemplate and uid
    const cronRes = await fetch(
      `${K8S}/apis/batch/v1/namespaces/${namespace}/cronjobs/${name}`,
      { headers: { Accept: 'application/json' } },
    )
    if (!cronRes.ok) return NextResponse.json({ ok: false, error: 'CronJob not found' }, { status: 404 })
    const cron = await cronRes.json()

    const jobName = `${name}-manual-${Date.now().toString(36)}`
    const job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace,
        annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' },
        labels: { ...(cron.metadata.labels ?? {}), 'vynops.io/triggered-by': 'ui' },
        ownerReferences: [{
          apiVersion: 'batch/v1', kind: 'CronJob', name,
          uid: cron.metadata.uid, blockOwnerDeletion: true, controller: true,
        }],
      },
      spec: cron.spec.jobTemplate.spec,
    }

    const r = await fetch(`${K8S}/apis/batch/v1/namespaces/${namespace}/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(job),
    })
    const j = await r.json()
    return NextResponse.json(r.ok ? { ok: true, jobName } : { ok: false, error: j.message })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
