export interface OnCallMember {
  id: string
  name: string
  email: string
  slack?: string
}

export interface EscalationLevel {
  level: number
  delayMins: number
  description: string
  memberId?: string
}

export interface OnCallSchedule {
  id: string
  name: string
  rotationDays: number
  rotationStart: string
  members: OnCallMember[]
  escalationLevels: EscalationLevel[]
  overrideUntil?: string
  overrideMember?: OnCallMember
}

export interface OnCallData {
  schedules: OnCallSchedule[]
}

export function resolveEscalationContact(schedule: OnCallSchedule, index: number, now = Date.now()): OnCallMember | undefined {
  const memberId = schedule.escalationLevels[index]?.memberId
  if (memberId) return schedule.members.find(member => member.id === memberId)
  if (index === 0 && schedule.overrideMember && schedule.overrideUntil && new Date(schedule.overrideUntil).getTime() > now) return schedule.overrideMember
  if (!schedule.members.length) return undefined
  const rotationMs = schedule.rotationDays * 86400000
  const start = new Date(schedule.rotationStart).getTime()
  const rotation = rotationMs > 0 && Number.isFinite(start) ? Math.floor((now - start) / rotationMs) : 0
  const memberIndex = ((rotation + index) % schedule.members.length + schedule.members.length) % schedule.members.length
  return schedule.members[memberIndex]
}
