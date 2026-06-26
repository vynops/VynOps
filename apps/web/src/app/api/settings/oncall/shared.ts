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
