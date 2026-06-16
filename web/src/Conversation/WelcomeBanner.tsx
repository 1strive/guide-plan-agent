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
    <div className="text-center py-12">
      <div className="w-14 h-14 mx-auto mb-5 rounded-xl bg-accent-soft text-primary grid place-items-center shadow-mist">
        <IconCompass size={28} />
      </div>
      <h2 className="text-[20px] font-semibold mb-2 text-foreground">
        开始规划你的下一段旅程
      </h2>
      <p className="text-[14px] text-muted-foreground">
        告诉我目的地、时间和偏好，我来帮你规划最合适的路线
      </p>
      <div className="flex justify-center flex-wrap gap-3 mt-7">
        {CHIPS.map((chip) => (
          <button
            key={chip.label}
            className="px-4 py-2.5 border border-border rounded-full text-[13px] text-foreground bg-surface hover:border-primary hover:bg-accent-soft hover:text-primary transition-all duration-200 shadow-subtle"
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
