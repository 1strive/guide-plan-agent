import { IconSearch } from "./Icons";

type SearchBoxProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
};

export function SearchBox({
  value,
  onChange,
  placeholder = "搜索历史对话...",
}: SearchBoxProps) {
  return (
    <div className="relative">
      <IconSearch
        size={14}
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sidebar-muted pointer-events-none"
      />
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-[36px] pl-8 pr-3 bg-sidebar-hover border border-transparent rounded-lg text-sidebar-fg text-[13px] outline-none placeholder:text-sidebar-muted focus:border-sidebar-primary focus:bg-sidebar-active transition-colors"
      />
    </div>
  );
}
