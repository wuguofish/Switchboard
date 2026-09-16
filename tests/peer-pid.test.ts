import { describe, expect, test } from 'bun:test'
import { peerPidForClientPort, pidOwningSocket, socketInodeForLocalPort } from '../peer-pid'

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
      const inode = socketInodeForLocalPort(port)
      expect(inode).not.toBeNull()
      expect(pidOwningSocket(inode!, [999_999, process.pid])).toBe(process.pid)
      expect(peerPidForClientPort(port, [process.pid])).toBe(process.pid)
    })
  })

  test('returns null when the owner is not among the candidates', async () => {
    await withLoopbackConnection((port) => {
      expect(peerPidForClientPort(port, [999_999])).toBeNull()
    })
  })

  test('returns null for a port nobody holds', () => {
    expect(socketInodeForLocalPort(1)).toBeNull()
    expect(peerPidForClientPort(1, [process.pid])).toBeNull()
  })
})
