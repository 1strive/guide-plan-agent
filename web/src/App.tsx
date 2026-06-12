import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Sidebar } from "./components/Sidebar";
import { ChatHeader } from "./components/ChatHeader";
import { MessageList } from "./Conversation/MessageList";
import { InputBar } from "./ChatInput/InputBar";

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <Sidebar />
        <main className="flex-1 flex flex-col overflow-hidden min-w-0">
          <ChatHeader />
          <MessageList />
          <InputBar />
        </main>
      </div>
    </QueryClientProvider>
  );
}
