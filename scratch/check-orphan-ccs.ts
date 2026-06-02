import { Database } from 'bun:sqlite'

const db = new Database('C:/Users/ATone/.claude/switchboard.db', { readonly: true })
const ids = [
  '76506fab-ebdb-4d5c-adbf-7e0be5eb1dc4',
  '88a3cf5a-8add-42de-9f0a-89c01fb3f4d3',
  '90d5a83d-27f3-4a38-b51f-81dbc7ef63a4',
]
for (const cc of ids) {
  const rows = db.query('SELECT id, alias, cc_session_id, last_activity, released_at FROM sessions WHERE cc_session_id = ?').all(cc)
  console.log(cc, JSON.stringify(rows))
}
