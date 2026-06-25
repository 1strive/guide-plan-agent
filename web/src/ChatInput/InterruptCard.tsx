import { useStreamChat } from "../hooks/useStreamChat";
import type { InterruptInfo } from "../types";
import { useChatStore } from "../store/chatStore";
import { Chip } from "../components/ui";
import { IconCheck } from "../components/Icons";

/**
 * 中断卡片组件：支持多问题纵向展开
 * - 未回答：展示所有可选项
 * - 已回答：仅显示选中答案
 */
export function InterruptCard({ interrupt }: { interrupt: InterruptInfo }) {
  const sending = useChatStore((s) => s.sending);
  const { handleOptionClick } = useStreamChat();

  // 已回答状态：仅显示选中的答案
  if (interrupt.selectedAnswer) {
    return (
      <div className="flex items-center gap-2 mt-4">
        <Chip variant="done">
          <IconCheck size={12} />
          {interrupt.selectedAnswer}
        </Chip>
      </div>
    );
  }

  // 未回答状态：展示所有问题与选项
  const questionsWithOptions = interrupt.questions.filter(
    (q) => q.options && q.options.length > 0,
  );
  if (questionsWithOptions.length === 0) return null;

  return (
    <div className="flex flex-col gap-4 mt-4">
      {questionsWithOptions.map((q, qi) => (
        <div key={q.id || qi}>
          {/* 多问题时显示各问题文本 */}
          {questionsWithOptions.length > 1 && q.message && (
            <div className="text-xs text-muted-foreground mb-2">
              {q.message}
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            {q.options!.map((opt, idx) => (
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
        </div>
      ))}
    </div>
  );
}
