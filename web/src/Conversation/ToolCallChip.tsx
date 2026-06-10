import type { ToolCallInfo } from "../types";
import { Chip } from "../components/ui";

export function ToolCallChip({ toolCall }: { toolCall: ToolCallInfo }) {
  const variant = toolCall.status === "running" ? "running" : "done";
  return (
    <Chip variant={variant}>
      {toolCall.status === "running" ? "⏳" : "✅"} {toolCall.name}
    </Chip>
  );
}
