import type { RefObject } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect } from 'react'

interface DeviceMousePosition {
  x: number
  y: number
}

/**
 * 根据元素的真实屏幕位置自动切换桌宠窗口的点击穿透。
 *
 * 穿透后 WebView 不再收到 mouseenter/mouseleave，因此通过 Rust 端 rdev
 * 全局鼠标流获取设备像素坐标，再与元素的 DOMRect 命中区比较。调用方只需
 * 传入可交互元素的 ref，不需要管理启动监听、窗口移动、缩放或穿透状态。
 *
 * # 兼容性（issue #394）
 *
 * 初始整体穿透**不**在挂载时急切调用 `setIgnoreCursorEvents(true)`：Linux /
 * Wayland 下窗口是异步 realize 的，挂载时 GDK 窗口实体可能尚未建立，tao
 * 0.35.3 收到 `CursorIgnoreEvents` 请求会走 `window.window().unwrap()` →
 * panic 崩掉整个事件循环。改为延后到首个 `device-mouse-move` 事件（此时窗口
 * 已 realize、事件循环健康）再按命中区计算应用，与 BongoCat 只在鼠标移动回调
 * 里才 `setIgnoreCursorEvents` 的做法一致。
 */
export function useOmitIgnoreCursorEvents(elementRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const appWindow = getCurrentWindow()
    let disposed = false
    // 初始为 false 以对齐真实 OS 状态（窗口创建后默认不穿透）：我们不再在挂载
    // 时急切开启穿透（见函数上方的 #394 说明），穿透态由首个 device-mouse-move
    // 事件按命中区计算后应用。
    let isIgnored = false
    let windowPosition: { x: number, y: number } | undefined
    let geometryRevision = 0
    let unlistenMouseMove: (() => void) | undefined
    let unlistenMoved: (() => void) | undefined
    let unlistenResized: (() => void) | undefined

    function setIgnoreCursorEvents(ignore: boolean): void {
      if (ignore === isIgnored)
        return
      isIgnored = ignore
      void appWindow.setIgnoreCursorEvents(ignore).catch(() => {})
    }

    async function refreshWindowPosition(): Promise<void> {
      const revision = ++geometryRevision
      const position = await appWindow.innerPosition()
      if (!disposed && revision === geometryRevision)
        windowPosition = position
    }

    function isCursorInElement(x: number, y: number): boolean | undefined {
      const element = elementRef.current
      if (element === null || windowPosition === undefined)
        return undefined

      const rect = element.getBoundingClientRect()
      const scale = globalThis.devicePixelRatio || 1
      const left = windowPosition.x + rect.left * scale
      const top = windowPosition.y + rect.top * scale
      const width = rect.width * scale
      const height = rect.height * scale
      return x >= left && x <= left + width && y >= top && y <= top + height
    }

    // 初始整窗穿透延后应用（见上方 #394 说明）：这里只启动鼠标流与窗口几何追踪，
    // 首个 device-mouse-move 事件到来后再按命中区决定穿透态，避免挂载即调用
    // setIgnoreCursorEvents 触发 tao 在未 realize 窗口上的 unwrap（issue #394）。
    void invoke('start_pet_mouse_stream').catch(() => {})
    void refreshWindowPosition()

    const movedPromise = appWindow.onMoved(() => {
      void refreshWindowPosition()
    })
    const resizedPromise = appWindow.onResized(() => {
      void refreshWindowPosition()
    })
    const mouseMovePromise = listen<DeviceMousePosition>('device-mouse-move', ({ payload }) => {
      // 挂载时的位置刷新是异步的，首个事件到来时可能还没拿到窗口坐标；补拉一次，
      // 让初始命中判定尽快给出明确结果，由此把初始穿透态一次应用到位。
      if (windowPosition === undefined)
        void refreshWindowPosition()
      const inElement = isCursorInElement(payload.x, payload.y)
      if (inElement !== undefined)
        setIgnoreCursorEvents(!inElement)
    })

    void Promise.all([movedPromise, resizedPromise, mouseMovePromise]).then(([moved, resized, mouseMove]) => {
      if (disposed) {
        moved()
        resized()
        mouseMove()
      }
      else {
        unlistenMoved = moved
        unlistenResized = resized
        unlistenMouseMove = mouseMove
      }
    }).catch(() => {})

    return () => {
      disposed = true
      geometryRevision++
      unlistenMoved?.()
      unlistenResized?.()
      unlistenMouseMove?.()
    }
  }, [elementRef])
}
