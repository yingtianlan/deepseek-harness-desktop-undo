import type { ReactNode } from 'react'
import type { ToastUpdateEvent } from '@/utils/toast'
import { useEventBus } from '@hairy/react-lib'
import { Spinner, Toast } from '@heroui/react'
import { useState } from 'react'
import { If } from 'react-if-lite'
import { activeQueues, placements } from '@/utils/toast'

interface ToastProviderProps {
  children?: ReactNode
  custom?: boolean
}

/**
 * 应用共用的 HeroUI queue/provider。桌宠窗口仅通过 hideCloseButton 使用
 * 自定义渲染分支，仍复用这里的 queues 与 src/utils/toast.ts API。
 */
export function ToastProvider(props: ToastProviderProps) {
  const [updates, setUpdates] = useState(() => new Map<string, ToastUpdateEvent['options']>())

  useEventBus<ToastUpdateEvent>('toast.update').on((event) => {
    if (event === undefined || typeof event.key !== 'string')
      return
    setUpdates((current) => {
      const next = new Map(current)
      next.set(event.key, { ...(current.get(event.key) ?? {}), ...event.options })
      return next
    })
  })

  return (
    <>
      {placements.map(placement => (
        <Toast.Provider
          key={placement}
          placement={placement}
          queue={activeQueues[placement]}
        >
          {props.custom
            ? ({ toast: item }) => {
                const content = { ...item.content, ...updates.get(item.key) }
                return (
                  <Toast toast={item} variant={content?.variant}>
                    <If cond={content?.isLoading} else={<Toast.Indicator variant={content?.variant} />}>
                      <Toast.Indicator variant={content?.variant}>
                        <Spinner color="current" size="sm" />
                      </Toast.Indicator>
                    </If>
                    <Toast.Content>
                      <If cond={content?.title !== undefined}>
                        <Toast.Title>{content?.title}</Toast.Title>
                      </If>
                      <If cond={content?.description !== undefined}>
                        <Toast.Description className="line-clamp-2">
                          {content?.description}
                        </Toast.Description>
                      </If>
                    </Toast.Content>
                  </Toast>
                )
              }
            : null}
        </Toast.Provider>
      ))}
      {props.children}
    </>
  )
}
