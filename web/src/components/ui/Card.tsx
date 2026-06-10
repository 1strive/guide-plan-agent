/**
 * Card — 设计系统基础容器
 *
 * 配套规范：web/DESIGN.md §7.3 Card
 * 默认：bg-card + 1px border + rounded-lg + shadow-card + padding 16
 *
 * Props:
 *   - padding   控制内边距（默认 'md' = p-4；'none' 时由调用方自行控制）
 *   - elevation 控制阴影（subtle / card 默认 / popover / mist）
 */

import type { HTMLAttributes, ReactNode } from "react";

type Padding = "none" | "sm" | "md" | "lg";
type Elevation = "subtle" | "card" | "popover" | "mist";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: Padding;
  elevation?: Elevation;
  children: ReactNode;
}

const PADDING_CLASS: Record<Padding, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-5",
};

const ELEVATION_CLASS: Record<Elevation, string> = {
  subtle: "shadow-subtle",
  card: "shadow-card",
  popover: "shadow-popover",
  mist: "shadow-mist",
};

export function Card({
  padding = "md",
  elevation = "card",
  className = "",
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={`bg-card text-card-foreground border border-border rounded-lg ${ELEVATION_CLASS[elevation]} ${PADDING_CLASS[padding]} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
