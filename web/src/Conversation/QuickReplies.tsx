import { useChatStore } from "../store/chatStore";

export function QuickReplies({ options }: { options: string[] }) {
  if (!options.length) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-3">
      {options.map((opt, i) => (
        <button
          key={i}
          className="px-3 py-1.5 border border-border rounded-full text-xs text-foreground bg-surface hover:border-primary hover:bg-accent-soft transition-colors"
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
