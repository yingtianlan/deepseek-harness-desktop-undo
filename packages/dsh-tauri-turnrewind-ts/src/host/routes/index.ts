/**
 * host/routes/index.ts — 同源 HTTP 路由（/api/turnrewind/*）。
 *
 * ✓/✗ 按钮经此驱动两阶段确认：confirm（POST，loopback-only）原子 claim 后执行；
 * cancel（POST）；status（GET）供卡片轮询 plan 结局。与 worktree 插件的
 * jsonRoute 模式一致：方法严格限制、body 上限、变更仅回环。
 */

import { Buffer } from 'node:buffer'
import { MAX_ROUTE_BODY_BYTES } from '../constants'

export interface RouteRequest {
  method?: string
  url?: string
  socket?: { remoteAddress?: string }
  on: (event: string, listener: (...args: any[]) => void) => void
  setHeader?: (name: string, value: string) => void
}

export interface RouteResponse {
  writeHead: (code: number, headers: Record<string, string>) => void
  setHeader: (name: string, value: string) => void
  end: (body?: string) => void
}

export type RouteHandler = (body: Record<string, unknown>, req: RouteRequest) => Promise<[number, unknown]> | [number, unknown]

export interface WebRoute {
  kind: 'exact'
  path: string
  handler: (req: RouteRequest, res: RouteResponse) => void
}

export function jsonRoute(path: string, handler: RouteHandler, { mutate = false }: { mutate?: boolean } = {}): WebRoute {
  return {
    kind: 'exact',
    path,
    handler(req: RouteRequest, res: RouteResponse) {
      const send = (code: number, payload: unknown): void => {
        const body = JSON.stringify(payload)
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(body)
      }
      if (mutate && req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        send(405, { error: 'mutation routes require POST' })
        return
      }
      const parts: string[] = []
      let totalBytes = 0
      let tooLarge = false
      req.on('data', (chunk: Buffer | string) => {
        if (tooLarge)
          return
        const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        totalBytes += Buffer.byteLength(value, 'utf8')
        if (totalBytes > MAX_ROUTE_BODY_BYTES) {
          tooLarge = true
          return
        }
        parts.push(value)
      })
      req.on('error', () => send(400, { error: 'request stream failed' }))
      req.on('end', () => {
        void (async () => {
          if (tooLarge)
            return send(413, { error: 'request body too large' })
          if (mutate) {
            const peer = req.socket?.remoteAddress ?? ''
            const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
            if (!loopback)
              return send(403, { error: 'mutation routes only accept loopback calls' })
          }
          try {
            const parsed = JSON.parse(parts.join('') || '{}') as Record<string, unknown>
            const [code, payload] = await handler(parsed, req)
            send(code, payload)
          }
          catch (error) {
            send(500, { error: String((error as Error)?.message ?? error) })
          }
        })()
      })
    },
  }
}
