import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Sidebar } from './components/Sidebar'
import { ChatHeader } from './components/ChatHeader'
import { MessageList } from './Conversation/MessageList'
import { InputBar } from './ChatInput/InputBar'

const queryClient = new QueryClient()

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="app">
        <Sidebar />
        <main className="chat-area">
          <ChatHeader />
          <MessageList />
          <InputBar />
        </main>
      </div>
    </QueryClientProvider>
  )
}
