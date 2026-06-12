import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const MD_PROPS = {
  remarkPlugins: [remarkGfm],
};

function TextContentInner({ content }: { content: string }) {
  if (!content) return null;
  return (
    <div
      className="text-sm leading-[1.75] text-foreground
      [&_p]:mb-3 [&_p:last-child]:mb-0
      [&_strong]:font-semibold
      [&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2
      [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2
      [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3:first-child]:mt-0
      [&_h4]:text-sm [&_h4]:font-semibold [&_h4]:mt-4 [&_h4]:mb-2 [&_h4:first-child]:mt-0
      [&_ul]:pl-5 [&_ul]:mb-3 [&_ul]:list-disc
      [&_ol]:pl-5 [&_ol]:mb-3 [&_ol]:list-decimal
      [&_li]:mb-1
      [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-muted [&_code]:text-[13px] [&_code]:font-mono
      [&_pre]:p-3 [&_pre]:mb-3 [&_pre]:bg-muted [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre_code]:p-0 [&_pre_code]:bg-transparent
      [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2
      [&_blockquote]:border-l-[3px] [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-fg-muted [&_blockquote]:mb-3
      [&_hr]:border-border [&_hr]:my-4
      [&_table]:w-full [&_table]:mb-3 [&_table]:border-collapse
      [&_th]:text-left [&_th]:font-semibold [&_th]:py-1.5 [&_th]:px-2 [&_th]:border-b [&_th]:border-border-strong
      [&_td]:py-1.5 [&_td]:px-2 [&_td]:border-b [&_td]:border-border"
    >
      <ReactMarkdown {...MD_PROPS}>{content}</ReactMarkdown>
    </div>
  );
}

export const TextContent = memo(TextContentInner);
