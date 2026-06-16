import { useState } from "react";
import { IconLightbulb, IconChevronDown } from "../components/Icons";

export function ThinkingBlock({ thinking }: { thinking: string }) {
  const [open, setOpen] = useState(true);

  return (
    <div
      className={
        "mb-4 rounded-xl overflow-hidden bg-think-bg border border-think-border shadow-subtle " +
        (!open ? "thinking-collapsed" : "")
      }
    >
      <button
        className="flex items-center gap-2 px-4 py-3 w-full text-left text-[13px] font-medium text-think-accent hover:bg-[color-mix(in_srgb,var(--think-bg)_90%,var(--think-border))] transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <IconLightbulb size={15} />
        <span className="flex-1">思考过程</span>
        <IconChevronDown
          size={15}
          className={
            "text-muted-foreground transition-transform duration-200 " +
            (!open ? "-rotate-90" : "")
          }
        />
      </button>
      <div
        className="px-4 pb-3.5 text-[13px] leading-[1.75] text-think-content whitespace-pre-wrap break-words transition-all duration-300 ease-in-out overflow-hidden"
        style={{
          maxHeight: open ? "600px" : "0",
          paddingTop: open ? undefined : "0",
          paddingBottom: open ? undefined : "0",
          opacity: open ? 1 : 0,
        }}
      >
        {thinking}
      </div>
    </div>
  );
}
