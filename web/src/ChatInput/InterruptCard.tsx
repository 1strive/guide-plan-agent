import { useStreamChat } from "../hooks/useStreamChat";
import type { InterruptInfo } from "../types";
import { useChatStore } from "../store/chatStore";
import { Chip } from "../components/ui";

export function InterruptCard({ interrupt }: { interrupt: InterruptInfo }) {
  const sending = useChatStore((s) => s.sending);
  const { handleOptionClick } = useStreamChat();

  if (!interrupt.options || interrupt.options.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-3 mt-4">
      {interrupt.options.map((opt, idx) => (
        <Chip
          key={idx}
          asButton
          variant="accentOutline"
          disabled={sending}
          onClick={() => handleOptionClick(opt)}
        >
          {opt}
        </Chip>
      ))}
    </div>
  );
}
