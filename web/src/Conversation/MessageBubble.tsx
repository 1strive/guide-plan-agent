import type { ReactNode } from "react";
import type { ChatMsg } from "../types";
import { TextContent } from "./TextContent";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallChip } from "./ToolCallChip";
import { InterruptCard } from "../ChatInput/InterruptCard";
import { Toolbox } from "./Toolbox";
import { QuickReplies } from "./QuickReplies";
import { RouteMapView } from "./RouteMapView";
import { IconCompass } from "../components/Icons";
import { useChatStore } from "../store/chatStore";

/**
 * 消息片段渲染上下文
 * 每条注册项通过 ctx 拿到当前消息与辅助回调
 */
type RendererContext = {
  msg: ChatMsg;
  prevUserContent?: string;
};

/**
 * 消息片段组件注册表
 *
 * 新增消息类型：只需在此数组追加一个 { key, render } 条目，
 * AssistantBubble 内部无需任何改动。
 *
 * key   — 调试标识（目前仅用于 React key，未来可扩展为显隐配置）
 * render — 返回 JSX 或 null（null 表示该片段当前不需要渲染）
 */
const rendererComponents: Array<{
  key: string;
  render: (ctx: RendererContext) => ReactNode;
}> = [
  // ── 中断状态标签（未回答时显示「需要补充信息」） ──
  {
    key: "interrupt-badge",
    render: ({ msg }) =>
      msg.interrupt && !msg.interrupt.selectedAnswer ? (
        <div className="inline-block px-3 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-semibold mb-3 shadow-mist">
          需要补充信息
        </div>
      ) : null,
  },
  // ── 思维过程 ──
  {
    key: "thinking",
    render: ({ msg }) =>
      msg.thinking ? <ThinkingBlock thinking={msg.thinking} /> : null,
  },
  // ── 正文内容 ──
  {
    key: "content",
    render: ({ msg }) => <TextContent content={msg.content} />,
  },
  // ── 工具调用 ──
  {
    key: "toolCalls",
    render: ({ msg }) =>
      msg.toolCalls && msg.toolCalls.length > 0 ? (
        <div className="flex flex-wrap gap-2 mt-4">
          {msg.toolCalls.map((tc, j) => (
            <ToolCallChip key={j} toolCall={tc} />
          ))}
        </div>
      ) : null,
  },
  // ── 导航地图 ──
  {
    key: "mapRoutes",
    render: ({ msg }) => {
      console.log({ msg }, "ja mapRoutes");

      return msg.mapRoutes && msg.mapRoutes.length > 0 ? (
        <div className="flex flex-col gap-2 mt-2">
          {msg.mapRoutes.map((r, j) => (
            <RouteMapView key={j} route={r} />
          ))}
        </div>
      ) : null;
    },
  },
  // ── 中断交互卡片 ──
  {
    key: "interrupt",
    render: ({ msg }) =>
      msg.interrupt ? <InterruptCard interrupt={msg.interrupt} /> : null,
  },
  // ── 操作工具箱（复制、重试） ──
  {
    key: "toolbox",
    render: ({ msg, prevUserContent }) => {
      const handleRetry = prevUserContent
        ? () => useChatStore.getState().setInput(prevUserContent)
        : undefined;
      return msg.content ? (
        <Toolbox content={msg.content} onRetry={handleRetry} />
      ) : null;
    },
  },
  // ── 快捷回复 ──
  {
    key: "quickReplies",
    render: ({ msg }) =>
      msg.quickReplies ? <QuickReplies options={msg.quickReplies} /> : null,
  },
];

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end mb-8">
      <div className="bg-user-bg text-user-fg px-4 py-3 rounded-2xl rounded-br-md max-w-[560px] text-[14px] leading-[1.7] whitespace-pre-wrap break-words shadow-card">
        {content}
      </div>
    </div>
  );
}

/**
 * Assistant 消息气泡
 *
 * 内部不再硬编码各字段的条件渲染，而是遍历 rendererComponents 注册表
 * 逐条调用 render()，新增消息片段类型只需在注册表追加条目。
 */
function AssistantBubble({
  msg,
  prevUserContent,
}: {
  msg: ChatMsg;
  prevUserContent?: string;
}) {
  const ctx: RendererContext = { msg, prevUserContent };

  console.log({ msg, ctx }, "ja assistant");

  return (
    <div className="flex gap-4 items-start mb-8 group">
      <div className="w-8 h-8 rounded-lg bg-accent-soft text-primary grid place-items-center flex-shrink-0 mt-0.5 shadow-subtle">
        <IconCompass size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-muted-foreground mb-2">
          路书
        </div>
        {rendererComponents.map((entry) => {
          const node = entry.render(ctx);
          return node ? <div key={entry.key}>{node}</div> : null;
        })}
      </div>
    </div>
  );
}

export function MessageBubble({
  msg,
  prevUserContent,
}: {
  msg: ChatMsg;
  prevUserContent?: string;
}) {
  if (msg.role === "user") {
    return <UserBubble content={msg.content} />;
  }
  return <AssistantBubble msg={msg} prevUserContent={prevUserContent} />;
}
