import { create } from 'zustand'
import type { ChatMsg, InterruptInfo } from '../types'

interface ChatState {
  activeId: string | null
  setActiveId: (id: string | null) => void

  messages: ChatMsg[]
  setMessages: (msgs: ChatMsg[] | ((prev: ChatMsg[]) => ChatMsg[])) => void
  appendMessage: (msg: ChatMsg) => void
  updateLastAssistant: (partial: Partial<ChatMsg>) => void

  input: string
  setInput: (v: string) => void

  sending: boolean
  setSending: (v: boolean) => void

  pendingInterrupt: InterruptInfo | null
  setPendingInterrupt: (v: InterruptInfo | null) => void

  // ref 语义:不驱动渲染,仅跨组件共享
  streamCtrl: AbortController | null
  setStreamCtrl: (v: AbortController | null) => void
  currentRunId: string | null
  setCurrentRunId: (v: string | null) => void

  abortInFlight: () => void
  resetChat: () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  activeId: null,
  setActiveId: (id) => set({ activeId: id }),

  messages: [],
  setMessages: (msgs) =>
    set((state) => ({
      messages: typeof msgs === 'function' ? msgs(state.messages) : msgs,
    })),
  appendMessage: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),
  updateLastAssistant: (partial) =>
    set((state) => {
      const next = [...state.messages]
      const last = next[next.length - 1]
      if (last && last.role === 'assistant') {
        next[next.length - 1] = { ...last, ...partial }
      }
      return { messages: next }
    }),

  input: '',
  setInput: (v) => set({ input: v }),

  sending: false,
  setSending: (v) => set({ sending: v }),

  pendingInterrupt: null,
  setPendingInterrupt: (v) => set({ pendingInterrupt: v }),

  streamCtrl: null,
  setStreamCtrl: (v) => set({ streamCtrl: v }),
  currentRunId: null,
  setCurrentRunId: (v) => set({ currentRunId: v }),

  abortInFlight: () => {
    const { streamCtrl } = get()
    if (streamCtrl) {
      streamCtrl.abort()
    }
    set({ streamCtrl: null, currentRunId: null })
  },
  resetChat: () =>
    set({ messages: [], pendingInterrupt: null }),
}))
