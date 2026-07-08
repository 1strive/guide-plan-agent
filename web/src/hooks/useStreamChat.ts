import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '../store/chatStore'
import * as api from '../api'
import type { AgUiEvent, InterruptInfo } from '../types'
import { consumeAgUiStream, type AgUiStreamPlugin } from './agUiProtocol'

/**
 * 实时 store 同步插件：把协议归约状态实时投射到 chatStore。
 * 这是「仅在对话流实时进行时才需要的行为」——批量归约(reduceAgUiEvents)不装载它。
 *
 * hasPreAssistantStub:调用方是否已经 push 了 placeholder assistant 占位
 *   - true: handleSend/Option 路径
 *   - false: 续订路径(第一个内容事件来时 lazy 加)
 */
function createStoreSyncPlugin(hasPreAssistantStub: boolean): AgUiStreamPlugin {
  const store = useChatStore.getState
  const set = useChatStore.setState
  let stubAdded = hasPreAssistantStub
  let lastRunId: string | undefined
  let lastPending: InterruptInfo | null = null

  const ensureStub = () => {
    if (!stubAdded) {
      store().appendMessage({ role: 'assistant', content: '', toolCalls: [] })
      stubAdded = true
    }
  }

  // 会引起「最后一条 assistant 消息」内容/工具/中断变化的事件（需刷新渲染）
  const CONTENT_EVENTS = new Set([
    'TEXT_MESSAGE_CONTENT',
    'THINKING_CONTENT',
    'TOOL_CALL_START',
    'TOOL_CALL_END',
    'RUN_ERROR',
    'ASK_USER',
    'RUN_FINISHED',
  ])

  return {
    onEvent(event, state) {
      // RUN_STARTED：仅记录 runId（供「停止」/续订用），不触发占位
      if (state.runId && state.runId !== lastRunId) {
        lastRunId = state.runId
        set({ currentRunId: state.runId })
      }
      // 中断状态抬到全局 store
      if (state.pendingInterrupt && state.pendingInterrupt !== lastPending) {
        lastPending = state.pendingInterrupt
        set({ pendingInterrupt: state.pendingInterrupt })
      }
      // 内容类事件：懒加占位 + 全量投射归约状态到最后一条 assistant 消息
      if (CONTENT_EVENTS.has(event.type)) {
        ensureStub()
        store().updateLastAssistant({
          content: state.content,
          thinking: state.thinking || undefined,
          toolCalls: state.toolCalls.length > 0 ? [...state.toolCalls] : undefined,
          interrupt: state.interrupt,
        })
      }
    },
    onError(error) {
      // 客户端 abort 属正常收尾，不写错误 UI
      if (error.name === 'AbortError') return
      ensureStub()
      store().updateLastAssistant({ content: `[请求失败] ${error.message}` })
    },
  }
}

/**
 * 公共事件循环:被 handleSend / handleOptionClick / startResume 复用。
 * 归约逻辑复用 agUiProtocol 注册表，实时副作用由 createStoreSyncPlugin 插件承担。
 */
async function consumeStream(
  stream: AsyncGenerator<AgUiEvent>,
  ctl: AbortController,
  hasPreAssistantStub: boolean,
  onFinished?: () => void,
) {
  const store = useChatStore.getState
  const set = useChatStore.setState
  try {
    await consumeAgUiStream(stream, [createStoreSyncPlugin(hasPreAssistantStub)])
    onFinished?.()
  } catch {
    // 错误 UI 已由插件 onError 处理；abort 静默收尾
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
