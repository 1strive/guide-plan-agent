import { useState } from "react";
import { useStreamChat } from "../hooks/useStreamChat";
import type { InterruptInfo } from "../types";
import { useChatStore } from "../store/chatStore";
import { Chip } from "../components/ui";
import { IconCheck, IconSend } from "../components/Icons";

/** 判断某个反问选项是否为「其他/自由输入」入口 */
function isFreeInputOption(opt: string): boolean {
  return /^(其他|其它|other)$/i.test(opt.trim());
}

/**
 * 中断卡片组件：支持多问题纵向展开
 * - 未回答：展示所有可选项；点击「其他」展开自由输入框（支持用户任意作答）
 * - 已回答：仅显示选中答案
 */
export function InterruptCard({ interrupt }: { interrupt: InterruptInfo }) {
  const sending = useChatStore((s) => s.sending);
  const { handleOptionClick } = useStreamChat();
  // 点击「其他」后切换到自由输入模式；otherText 承载用户输入
  const [freeInput, setFreeInput] = useState(false);
  const [otherText, setOtherText] = useState("");

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

  function submitFreeInput() {
    const text = otherText.trim();
    if (!text || sending) return;
    // 复用 handleOptionClick：把用户自由输入作为反问答案提交，走同一条 resume 通道
    handleOptionClick(text);
    setFreeInput(false);
    setOtherText("");
  }

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
                onClick={() =>
                  // 「其他」不直接提交，改为展开自由输入框；其余选项直接作答
                  isFreeInputOption(opt)
                    ? setFreeInput(true)
                    : handleOptionClick(opt)
                }
              >
                {opt}
              </Chip>
            ))}
          </div>
        </div>
      ))}

      {/* 「其他」自由输入框：仅在点击「其他」后出现 */}
      {freeInput && (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            type="text"
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitFreeInput();
              }
            }}
            disabled={sending}
            placeholder="请输入您的回答…"
            className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-border bg-card text-[13px] text-foreground outline-none focus:border-primary transition-colors disabled:opacity-60"
          />
          <button
            onClick={submitFreeInput}
            disabled={sending || otherText.trim().length === 0}
            title="提交回答"
            className="w-9 h-9 flex-shrink-0 rounded-lg bg-primary text-primary-foreground grid place-items-center hover:bg-accent-hover disabled:bg-border disabled:cursor-default transition-colors"
          >
            <IconSend size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
