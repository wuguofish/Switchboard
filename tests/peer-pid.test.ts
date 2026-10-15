import { describe, expect, test } from 'bun:test'
import { parseNetstatOwner, peerPidForClientPort, pidOwningSocket, socketInodeForLocalPort } from '../peer-pid'

const onLinux = process.platform !== 'win32'

async function withLoopbackConnection<T>(fn: (localPort: number) => T | Promise<T>): Promise<T> {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  return new Promise<T>((resolve, reject) => {
    Bun.connect({
      hostname: '127.0.0.1',
      port: listener.port,
      socket: {
        data() {},
        async open(socket) {
          try {
            resolve(await fn(socket.localPort))
          } catch (err) {
            reject(err)
          } finally {
            socket.end()
            listener.stop()
          }
        },
        connectError(_socket, err) { reject(err) },
      },
    })
  })
}

describe('peer pid lookup', () => {
  test('resolves this process as the owner of its own loopback connection', async () => {
    await withLoopbackConnection((port) => {
      expect(peerPidForClientPort(port, [process.pid])).toBe(process.pid)
    })
  })

  test('returns null when the owner is not among the candidates', async () => {
    await withLoopbackConnection((port) => {
      expect(peerPidForClientPort(port, [999_999])).toBeNull()
    })
  })

  test('returns null for a port nobody holds', () => {
    expect(peerPidForClientPort(1, [process.pid])).toBeNull()
  })
})

describe.if(onLinux)('socket inode lookup (linux)', () => {
  test('finds the inode of a live connection and the pid holding it', async () => {
    await withLoopbackConnection((port) => {
      const inode = socketInodeForLocalPort(port)
      expect(inode).not.toBeNull()
      expect(pidOwningSocket(inode!, [999_999, process.pid])).toBe(process.pid)
    })
  })

  test('returns null for a port nobody holds', () => {
    expect(socketInodeForLocalPort(1)).toBeNull()
  })
})

// Real `netstat -ano` output: the header is localised, the columns are not.
const NETSTAT_SAMPLE = [
  '',
  '使用中連線',
  '',
  '  協定   本機位址               外部位址               狀態            PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1520',
  '  TCP    127.0.0.1:52372        127.0.0.1:3456         TIME_WAIT       0',
  '  TCP    127.0.0.1:61706        127.0.0.1:9876         ESTABLISHED     37584',
  '  TCP    [::]:445               [::]:0                 LISTENING       4',
  '  TCP    [::1]:61800            [::1]:9876             ESTABLISHED     27052',
  '',
].join('\n')

describe('netstat parsing', () => {
  test('reads the pid of an established connection by its local port', () => {
    expect(parseNetstatOwner(NETSTAT_SAMPLE, 61706)).toBe(37584)
  })

  test('takes the port after the last colon, so IPv6 rows work too', () => {
    expect(parseNetstatOwner(NETSTAT_SAMPLE, 61800)).toBe(27052)
  })

  test('skips a closing connection, which is listed against pid 0', () => {
    expect(parseNetstatOwner(NETSTAT_SAMPLE, 52372)).toBeNull()
  })

  test('matches the local port only, never the remote one', () => {
    expect(parseNetstatOwner(NETSTAT_SAMPLE, 9876)).toBeNull()
  })

  test('returns null for a port that is not listed', () => {
    expect(parseNetstatOwner(NETSTAT_SAMPLE, 1)).toBeNull()
  })
})
