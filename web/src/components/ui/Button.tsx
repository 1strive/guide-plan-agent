/**
 * Button — 设计系统基础组件
 *
 * 配套规范：web/DESIGN.md §7.1 Button
 * 颜色守则：仅使用 token 工具类（bg-primary / text-primary-foreground / ...）
 *
 * Variants:
 *   - primary     主 CTA（海蓝）
 *   - secondary   次要操作（暖阳米）
 *   - ghost       透明 + 描边（图标按钮）
 *   - accent      强调（落日橙，需要用户决策时）
 *   - destructive 危险（删除）
 *
 * Sizes: sm 28 / md 36 / lg 40
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "accent" | "destructive";
type Size = "sm" | "md" | "lg" | "xl";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

const VARIANT_CLASS: Record<Variant, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/85",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "bg-transparent text-foreground border border-border hover:bg-muted",
  accent:
    "bg-accent text-accent-foreground hover:bg-accent/90 active:bg-accent/85",
  destructive:
    "bg-transparent text-muted-foreground hover:bg-destructive hover:text-destructive-foreground",
};

const SIZE_CLASS: Record<Size, string> = {
  sm: "h-8 px-3.5 text-[13px] rounded-md",
  md: "h-10 px-4 text-sm rounded-md",
  lg: "h-12 px-5 text-[15px] rounded-lg",
  xl: "h-14 px-8 text-base rounded-lg",
};

const BASE =
  "inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap " +
  "transition-colors duration-150 ease-in-out cursor-pointer " +
  "disabled:cursor-not-allowed disabled:bg-[var(--button-bg-disabled)] " +
  "disabled:text-muted-foreground disabled:hover:bg-[var(--button-bg-disabled)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`${BASE} ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
