import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '../store/chatStore'
import * as api from '../api'
import type { AgUiEvent, InterruptInfo, InterruptQuestion, ToolCallInfo } from '../types'

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
          // RUN_FINISHED 生命周期信号：若已有 ASK_USER 事件处理了中断渲染，此处不再重复设置。
          // 向下兼容：若后端未发 ASK_USER 而仅在 outcome 里带了 interrupt，仍然处理。
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
            // 只有在前面没有 ASK_USER 事件时才走此分支（兼容旧协议）
            const currentPending = store().pendingInterrupt
            if (!currentPending) {
              const questions: InterruptQuestion[] = outcome.interrupts.map((it) => ({
                id: it.id,
                message: it.message ?? '',
                reason: it.reason,
                options: it.metadata?.options,
              }))
              const interrupt: InterruptInfo = { questions }
              set({ pendingInterrupt: interrupt })
              ensureAssistantStub()
              const displayMsg = questions[0]?.message ?? ''
              store().setMessages((prev) => {
                const next = [...prev]
                const last = next[next.length - 1]!
                next[next.length - 1] = {
                  role: last.role,
                  content: displayMsg,
                  toolCalls: last.toolCalls,
                  interrupt,
                }
                return next
              })
            }
          }
          break
        }
        case 'RUN_ERROR': {
          ensureAssistantStub()
          assistantContent += `\n[错误] ${event.message}`
          updateLast()
          break
        }
        case 'ASK_USER': {
          // ASK_USER 独立一等事件：直接携带问题数据，前端据此渲染中断卡片
          const rawQuestions = event.questions as Array<{
            id: string
            message: string
            reason: string
            options?: string[]
          }>
          if (rawQuestions?.length) {
            const questions: InterruptQuestion[] = rawQuestions.map((q) => ({
              id: q.id,
              message: q.message,
              reason: q.reason,
              options: q.options,
            }))
            const interrupt: InterruptInfo = { questions }
            set({ pendingInterrupt: interrupt })
            ensureAssistantStub()
            const displayMsg = questions[0]?.message ?? ''
            store().setMessages((prev) => {
              const next = [...prev]
              const last = next[next.length - 1]!
              next[next.length - 1] = {
                role: last.role,
                content: displayMsg,
                toolCalls: last.toolCalls,
                interrupt,
              }
              return next
            })
          }
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

  /** 将最后一条带 interrupt 的 assistant 消息标记为已回答 */
  function markInterruptAnswered(answer: string) {
    useChatStore.getState().setMessages((prev) => {
      const next = [...prev]
      for (let i = next.length - 1; i >= 0; i--) {
        const m = next[i]!
        if (m.role === 'assistant' && m.interrupt && !m.interrupt.selectedAnswer) {
          next[i] = {
            role: m.role,
            content: m.content,
            thinking: m.thinking,
            toolCalls: m.toolCalls,
            quickReplies: m.quickReplies,
            interrupt: { ...m.interrupt, selectedAnswer: answer },
          }
          break
        }
      }
      return next
    })
  }

  const handleSend = useCallback(
    async (resumeInterrupt?: { id: string; reason: string }) => {
      const { input, activeId, sending, setInput, setPendingInterrupt, appendMessage, setSending, setStreamCtrl } =
        useChatStore.getState()
      const text = input.trim()
      if (!text || !activeId || sending) return

      // 回答中断时，标记上一条消息的 interrupt 为已回答
      if (resumeInterrupt) {
        markInterruptAnswered(text)
      }

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

      // 取第一个问题的 id/reason 用于恢复中断
      const firstQ = pendingInterrupt.questions[0]
      if (!firstQ) return
      const resumeInterrupt = { id: firstQ.id, reason: firstQ.reason }

      // 标记已回答
      markInterruptAnswered(option)

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
