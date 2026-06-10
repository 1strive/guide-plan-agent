/**
 * Tag — 设计系统静态标签（无交互）
 *
 * 配套规范：web/DESIGN.md §2 Colors / §5 Radius
 * 用途：ChatHeader 会话名 chip、Sidebar token 徽章、行程/景点元数据标签
 *
 * Tones:
 *   - neutral 中性（muted 底，muted-foreground 字）
 *   - primary 海蓝（secondary 底，primary 字 —— 与会话项徽章一致）
 *   - sand    沙金（chart-3 系，旅游元数据）
 *   - accent  落日橙（accent 底，反白字）
 *   - success 椰绿（chart-4 系，已完成）
 */

import type { HTMLAttributes, ReactNode } from "react";

type Tone = "neutral" | "primary" | "sand" | "accent" | "success";
type Size = "xs" | "sm";

interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  size?: Size;
  children: ReactNode;
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-secondary text-primary",
  sand: "bg-[color-mix(in_srgb,var(--chart-3)_18%,var(--card))] text-[color-mix(in_srgb,var(--chart-3)_70%,var(--foreground))]",
  accent: "bg-accent text-accent-foreground",
  success:
    "bg-[color-mix(in_srgb,var(--chart-4)_12%,var(--card))] text-chart-4",
};

const SIZE_CLASS: Record<Size, string> = {
  xs: "text-[10px] px-2 py-0.5 rounded",
  sm: "text-xs px-3 py-1 rounded-md",
};

export function Tag({
  tone = "neutral",
  size = "sm",
  className = "",
  children,
  ...rest
}: TagProps) {
  return (
    <span
      className={`inline-flex items-center font-medium whitespace-nowrap ${TONE_CLASS[tone]} ${SIZE_CLASS[size]} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}
