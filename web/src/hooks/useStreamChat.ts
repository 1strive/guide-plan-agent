import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '../store/chatStore'
import * as api from '../api'
import type { AgUiEvent, InterruptInfo, ToolCallInfo } from '../types'

/**
 * 公共事件循环:被 handleSend / handleOptionClick / startResume 复用。
 *
 * hasPreAssistantStub:调用方是否已经 push 了 placeholder assistant 占位
 *   - true: handleSend/Option 路径
 *   - false: 续订路径(第一个 TEXT 来时 lazy 加)
 */
async function consumeStream(
  stream: AsyncGenerator<AgUiEvent>,
  ctl: AbortController,
  hasPreAssistantStub: boolean,
  onFinished?: () => void,
) {
  const store = useChatStore.getState
  const set = useChatStore.setState

  let assistantContent = ''
  let assistantThinking = ''
  const toolCalls: ToolCallInfo[] = []
  let assistantStubAdded = hasPreAssistantStub

  const ensureAssistantStub = () => {
    if (!assistantStubAdded) {
      store().appendMessage({ role: 'assistant', content: '', toolCalls: [] })
      assistantStubAdded = true
    }
  }

  const updateLast = () => {
    store().updateLastAssistant({
      content: assistantContent,
      thinking: assistantThinking || undefined,
      toolCalls: [...toolCalls],
    })
  }

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'RUN_STARTED': {
          set({ currentRunId: event.runId as string })
          break
        }
        case 'TEXT_MESSAGE_CONTENT': {
          ensureAssistantStub()
          assistantContent += event.delta as string
          updateLast()
          break
        }
        case 'THINKING_CONTENT': {
          ensureAssistantStub()
          assistantThinking += event.delta as string
          updateLast()
          break
        }
        case 'TOOL_CALL_START': {
          ensureAssistantStub()
          toolCalls.push({ name: event.toolCallName as string, status: 'running' })
          updateLast()
          break
        }
        case 'TOOL_CALL_END': {
          const running = toolCalls.find((t) => t.status === 'running')
          if (running) running.status = 'done'
          updateLast()
          break
        }
        case 'RUN_FINISHED': {
          const outcome = event.outcome as
            | {
                type: string
                interrupts?: Array<{
                  id: string
                  message?: string
                  reason: string
                  metadata?: { options?: string[] }
                }>
              }
            | undefined
          if (outcome?.type === 'interrupt' && outcome.interrupts?.length) {
            const intItem = outcome.interrupts[0]!
            const interrupt: InterruptInfo = {
              id: intItem.id,
              message: intItem.message ?? '',
              reason: intItem.reason,
              options: intItem.metadata?.options,
            }
            set({ pendingInterrupt: interrupt })
            ensureAssistantStub()
            store().setMessages((prev) => {
              const next = [...prev]
              const last = next[next.length - 1]!
              next[next.length - 1] = {
                role: last.role,
                content: interrupt.message,
                toolCalls: last.toolCalls,
                interrupt,
              }
              return next
            })
          }
          break
        }
        case 'RUN_ERROR': {
          ensureAssistantStub()
          assistantContent += `\n[错误] ${event.message}`
          updateLast()
          break
        }
      }
    }
    onFinished?.()
  } catch (e) {
    if ((e as Error).name !== 'AbortError') {
      ensureAssistantStub()
      store().setMessages((prev) => {
        const next = [...prev]
        next[next.length - 1] = {
          role: 'assistant',
          content: `[请求失败] ${(e as Error).message}`,
        }
        return next
      })
    }
  } finally {
    const current = store()
    if (current.streamCtrl === ctl) {
      set({ streamCtrl: null })
    }
    set({ currentRunId: null, sending: false })
  }
}

export function useStreamChat() {
  const queryClient = useQueryClient()

  const invalidateSessions = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
    [queryClient],
  )

  const handleSend = useCallback(
    async (resumeInterrupt?: { id: string; reason: string }) => {
      const { input, activeId, sending, setInput, setPendingInterrupt, appendMessage, setSending, setStreamCtrl } =
        useChatStore.getState()
      const text = input.trim()
      if (!text || !activeId || sending) return

      setInput('')
      setPendingInterrupt(null)
      appendMessage({ role: 'user', content: text })
      appendMessage({ role: 'assistant', content: '', toolCalls: [] })
      setSending(true)

      const ctl = new AbortController()
      setStreamCtrl(ctl)
      useChatStore.setState({ currentRunId: null })

      const resume = resumeInterrupt
        ? [{ interruptId: resumeInterrupt.id, status: 'resolved' as const, payload: { answer: text } }]
        : undefined

      const stream = api.sendMessageStream(activeId, text, resume, ctl.signal)
      await consumeStream(stream, ctl, true, invalidateSessions)
    },
    [invalidateSessions],
  )

  const handleOptionClick = useCallback(
    (option: string) => {
      const { pendingInterrupt, sending, setInput, setPendingInterrupt, appendMessage, setSending, setStreamCtrl, activeId } =
        useChatStore.getState()
      if (!pendingInterrupt || sending || !activeId) return

      const resumeInterrupt = { id: pendingInterrupt.id, reason: pendingInterrupt.reason }
      setInput('')
      setPendingInterrupt(null)
      appendMessage({ role: 'user', content: option })
      appendMessage({ role: 'assistant', content: '', toolCalls: [] })
      setSending(true)

      const ctl = new AbortController()
      setStreamCtrl(ctl)
      useChatStore.setState({ currentRunId: null })

      const stream = api.sendMessageStream(
        activeId,
        option,
        [{ interruptId: resumeInterrupt.id, status: 'resolved' as const, payload: { answer: option } }],
        ctl.signal,
      )
      void consumeStream(stream, ctl, true, invalidateSessions)
    },
    [invalidateSessions],
  )

  const startResume = useCallback(
    async (sessionId: string, runId: string) => {
      const { setStreamCtrl, setSending } = useChatStore.getState()
      const ctl = new AbortController()
      setStreamCtrl(ctl)
      useChatStore.setState({ currentRunId: runId })
      setSending(true)

      try {
        const stream = api.resumeRunStream(sessionId, runId, 0, ctl.signal)
        await consumeStream(stream, ctl, false, invalidateSessions)
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          console.error('resume failed:', e)
        }
      }
    },
    [invalidateSessions],
  )

  const handleStop = useCallback(async () => {
    const { currentRunId, activeId, abortInFlight, setSending } = useChatStore.getState()
    if (!currentRunId || !activeId) return
    try {
      await api.cancelRun(activeId, currentRunId)
    } catch (e) {
      console.error('cancelRun failed:', e)
    }
    abortInFlight()
    setSending(false)
  }, [])

  return { handleSend, handleOptionClick, handleStop, startResume }
}
