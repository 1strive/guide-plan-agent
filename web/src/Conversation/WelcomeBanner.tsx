import { useChatStore } from "../store/chatStore";
import { IconCompass } from "../components/Icons";

const CHIPS = [
  { emoji: "🏔️", label: "西藏自驾", prompt: "帮我规划一次西藏自驾" },
  { emoji: "🏖️", label: "亲子海边", prompt: "推荐一条亲子海边路线" },
  { emoji: "🏕️", label: "周末露营", prompt: "周末露营好去处" },
  { emoji: "🛣️", label: "西北大环线", prompt: "西北大环线怎么走" },
];

export function WelcomeBanner() {
  return (
    <div className="text-center py-8">
      <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-accent-soft text-primary grid place-items-center">
        <IconCompass size={24} />
      </div>
      <h2 className="text-xl font-semibold mb-1.5">
        开始规划你的下一段旅程
      </h2>
      <p className="text-sm text-fg-muted">
        告诉我目的地、时间和偏好，我来帮你规划最合适的路线
      </p>
      <div className="flex justify-center flex-wrap gap-2 mt-5">
        {CHIPS.map((chip) => (
          <button
            key={chip.label}
            className="px-3.5 py-2 border border-border rounded-full text-[13px] text-foreground bg-surface hover:border-primary hover:bg-accent-soft transition-colors"
            onClick={() => {
              useChatStore.getState().setInput(chip.prompt);
            }}
          >
            {chip.emoji} {chip.label}
          </button>
        ))}
      </div>
    </div>
  );
}
