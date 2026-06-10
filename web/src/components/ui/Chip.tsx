/**
 * Chip — 设计系统胶囊（可点击 / 状态化）
 *
 * 配套规范：web/DESIGN.md §7.5 Tool Tag、§7.7 Interrupt Option
 * 用途：工具调用状态标签（idle/running/done）、Interrupt 选项胶囊
 *
 * 与 Tag 区别：Chip 强调"状态 + 可交互"，Tag 仅静态。
 *
 * Variants:
 *   - idle           中性静态
 *   - running        落日橙 + pulse 动画（工具运行中）
 *   - done           椰绿（工具完成）
 *   - accentOutline  暖橙描边胶囊，hover 实色（Interrupt 选项）
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "idle" | "running" | "done" | "accentOutline";

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  asButton?: boolean; // false 时渲染为 span（不可点击）
  children: ReactNode;
}

const VARIANT_CLASS: Record<Variant, string> = {
  idle: "bg-muted text-muted-foreground border border-border",
  running:
    "bg-[color-mix(in_srgb,var(--accent)_12%,var(--card))] text-accent border border-accent animate-pulse",
  done: "bg-[color-mix(in_srgb,var(--chart-4)_10%,var(--card))] text-chart-4 border border-[color-mix(in_srgb,var(--chart-4)_35%,var(--card))]",
  accentOutline:
    "bg-card text-accent border border-accent hover:bg-accent hover:text-accent-foreground active:scale-[0.96] disabled:opacity-50 disabled:hover:bg-card disabled:hover:text-accent disabled:cursor-not-allowed",
};

const BASE_CHIP =
  "inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap " +
  "transition-colors duration-150 ease-in-out";

const SIZE_TOOL = "h-7 px-3 rounded-md";
const SIZE_OPTION = "h-9 px-4 rounded-[18px] text-[13px] cursor-pointer";

export function Chip({
  variant = "idle",
  asButton = false,
  className = "",
  children,
  ...rest
}: ChipProps) {
  const sizeCls = variant === "accentOutline" ? SIZE_OPTION : SIZE_TOOL;
  const cls = `${BASE_CHIP} ${VARIANT_CLASS[variant]} ${sizeCls} ${className}`;

  if (asButton) {
    return (
      <button className={cls} {...rest}>
        {children}
      </button>
    );
  }
  return <span className={cls}>{children}</span>;
}
