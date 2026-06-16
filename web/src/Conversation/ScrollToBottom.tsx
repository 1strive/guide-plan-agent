import { useEffect, useState } from "react";
import { IconChevronDown } from "../components/Icons";

/**
 * 设计稿对齐：右下角浮动「回到底部」按钮。
 *
 * 监听传入容器的 scroll 事件，当距底部 > 100px 时显示，点击平滑回到底部。
 * 由父级 MessageList 传入容器 ref；按钮使用 absolute 定位（父级需 relative）。
 */
export function ScrollToBottom({
  containerRef,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setVisible(distance > 100);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [containerRef]);

  function handleClick() {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="回到底部"
      title="回到底部"
      className={
        "absolute bottom-10 right-10 w-10 h-10 rounded-full grid place-items-center " +
        "bg-card border border-border shadow-popover text-muted-foreground z-10 " +
        "hover:bg-surface-alt hover:text-foreground " +
        "transition-opacity duration-200 " +
        (visible
          ? "opacity-100 pointer-events-auto"
          : "opacity-0 pointer-events-none")
      }
    >
      <IconChevronDown size={18} />
    </button>
  );
}
