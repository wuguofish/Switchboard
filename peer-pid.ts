/**
 * Which local process is on the other end of a loopback TCP connection.
 *
 * The daemon only ever talks to processes of the same user on the same
 * machine, and both platforms expose enough to identify them. Linux:
 * /proc/net/tcp lists every socket with its local port and inode, and
 * /proc/<pid>/fd links back to `socket:[inode]`. Windows has no /proc, so
 * `netstat -ano` is asked instead, which names the owning pid directly and
 * skips the inode hop. Either way the answer counts only when it is one of
 * the candidate pids, so a connection from anything else stays unbound.
 */
import { readdirSync, readFileSync, readlinkSync } from 'fs'
import { join } from 'path'

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

/** Full path to netstat: a service runs with its own PATH, not the user's. */
function netstatPath(): string {
  return join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'netstat.exe')
}

/**
 * The pid `netstat -ano` lists for a local TCP port. Only the protocol, the
 * local address and the pid column are read: the table header and the
 * connection state are localised, the column order is not. IPv4 and IPv6
 * rows both say TCP, so the port is taken after the last colon.
 */
export function parseNetstatOwner(text: string, port: number): number | null {
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || cols[0] !== 'TCP') continue
    const local = cols[1]
    if (Number(local.slice(local.lastIndexOf(':') + 1)) !== port) continue
    // A closing connection is listed against pid 0; it owns nothing.
    const pid = Number(cols[4])
    if (pid > 0) return pid
  }
  return null
}

function windowsPidForLocalPort(port: number): number | null {
  const proc = Bun.spawnSync([netstatPath(), '-ano'], { stdout: 'pipe', stderr: 'ignore' })
  if (!proc.success) return null
  return parseNetstatOwner(proc.stdout.toString(), port)
}

/** Owner pid of the connection whose client-side port is `clientPort`. */
export function peerPidForClientPort(clientPort: number, candidatePids: number[]): number | null {
  if (process.platform === 'win32') {
    const pid = windowsPidForLocalPort(clientPort)
    return pid !== null && candidatePids.includes(pid) ? pid : null
  }
  const inode = socketInodeForLocalPort(clientPort)
  return inode ? pidOwningSocket(inode, candidatePids) : null
}
