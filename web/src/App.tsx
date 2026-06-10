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
        <main className="flex-1 flex flex-col px-6 py-5 gap-4 overflow-hidden">
          <ChatHeader />
          <MessageList />
          <InputBar />
        </main>
      </div>
    </QueryClientProvider>
  );
}
