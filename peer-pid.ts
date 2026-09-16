/**
 * Which local process is on the other end of a loopback TCP connection.
 *
 * The daemon only ever talks to processes of the same user on the same
 * machine, and Linux exposes enough to identify them: /proc/net/tcp lists
 * every socket with its local port and inode, and /proc/<pid>/fd links back
 * to `socket:[inode]`. Only the candidate pids are searched, so the cost is
 * a handful of readlinks per new connection.
 */
import { readdirSync, readFileSync, readlinkSync } from 'fs'

const PROC_NET_TABLES = ['/proc/net/tcp', '/proc/net/tcp6']

function hexPort(port: number): string {
  return port.toString(16).toUpperCase().padStart(4, '0')
}

/** Inode of the socket whose local port is `port`, or null when not listed. */
export function socketInodeForLocalPort(port: number, tables = PROC_NET_TABLES): string | null {
  const suffix = ':' + hexPort(port)
  for (const table of tables) {
    let text: string
    try {
      text = readFileSync(table, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10 || !cols[1].endsWith(suffix)) continue
      return cols[9]
    }
  }
  return null
}

/** The candidate pid holding a file descriptor for that socket inode. */
export function pidOwningSocket(inode: string, candidatePids: number[], procRoot = '/proc'): number | null {
  const target = `socket:[${inode}]`
  for (const pid of candidatePids) {
    const fdDir = `${procRoot}/${pid}/fd`
    let fds: string[]
    try {
      fds = readdirSync(fdDir)
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`${fdDir}/${fd}`) === target) return pid
      } catch {
        // fd closed between readdir and readlink
      }
    }
  }
  return null
}

/** Owner pid of the connection whose client-side port is `clientPort`. */
export function peerPidForClientPort(clientPort: number, candidatePids: number[]): number | null {
  const inode = socketInodeForLocalPort(clientPort)
  return inode ? pidOwningSocket(inode, candidatePids) : null
}
