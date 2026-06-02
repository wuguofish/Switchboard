// All shared types for switchboard. No runtime code here.

export type SessionId = string  // UUID

export interface SessionRow {
  id: SessionId
  alias: string | null
  cc_session_id?: string | null
  created_at: string    // ISO 8601 UTC
  last_activity: string // ISO 8601 UTC
  released_at?: string | null // ISO 8601 UTC; NULL means active
}

export interface MessageRow {
  id: string           // UUID
  sender_id: SessionId
  recipient_id: SessionId
  broadcast_id: string | null
  content: string
  created_at: string   // ISO 8601 UTC
  read_at: string | null
}

export interface SessionPublic {
  session_id: SessionId
  alias: string | null
  online: boolean
  created_at: string   // ISO 8601 Asia/Taipei (API response)
  last_activity: string
}

export interface MessagePublic {
  id: string
  sender_id: SessionId
  sender_alias: string | null
  content: string
  created_at: string   // ISO 8601 Asia/Taipei (API response)
  is_broadcast: boolean
}

export interface RegisterResult {
  session_id: SessionId
  alias: string | null
  anonymous: boolean
  hint?: string
}

export interface SendResult {
  message_id: string
  delivered_notification: boolean
}

export interface BroadcastResult {
  broadcast_id: string
  recipient_count: number
  notified_count: number
}

export interface RecallResult {
  recalled_count: number
}
