import { useChatStore } from "../store/chatStore";

export function QuickReplies({ options }: { options: string[] }) {
  if (!options.length) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-4">
      {options.map((opt, i) => (
        <button
          key={i}
          className="px-3.5 py-2 border border-border rounded-full text-[13px] text-foreground bg-card hover:border-primary hover:bg-accent-soft hover:text-primary transition-all duration-200 shadow-subtle"
          onClick={() => {
            useChatStore.getState().setInput(opt);
          }}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
