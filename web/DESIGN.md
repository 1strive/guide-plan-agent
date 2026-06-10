# Guide-Plan-Agent Web Design System

> 单文件设计系统，遵循 [DESIGN.md](https://designmd.ai/what-is-design-md) 规范（Google Stitch）。
> 任何 AI 编码工具（Qoder / Claude Code / Cursor / Copilot）读取本文件后，都应直接据此生成符合视觉与交互规范的 UI。

---

## 1. Brand & Tone

**产品定位**：旅游规划 Agent，主线场景为对话式旅行规划与目的地推荐。

**视觉关键词**：地中海阳光、海岸线、米白沙滩、温暖可信、克制不喧宾夺主。

**语气与情绪**：

- 亲切但专业，像一位熟悉本地的向导，不是热情过头的销售
- 信息密度优先于装饰；颜色与动效都为"指引视线"服务
- 用色谨慎：海蓝为主功能色（CTA、链接、选中），暖橙仅做点睛（运行中、需用户决策）

**Do / Don't**：

- DO：大面积留白 + 沙白底 + 海蓝点缀
- DO：用沙金色（chart-3）做"行程/景点"类信息标签
- DON'T：在普通卡片上叠多种暖色（避免热带过载）
- DON'T：写死任何 hex —— 必须使用 `var(--xxx)`

---

## 2. Colors

所有颜色以 CSS 变量声明在 `web/src/styles/tailwind.css` 的 `:root` 下。命名结构沿用 shadcn 体系，便于后续接入 `.dark` 模式（仅替换值，不改命名）。

### 2.1 Surface（表面层）

| Token                  | Hex       | 用途                         |
| ---------------------- | --------- | ---------------------------- |
| `--background`         | `#fdfaf3` | 全局页面底色（沙滩米白）     |
| `--foreground`         | `#1a2942` | 全局文字主色（深海蓝黑）     |
| `--surface`            | `#ffffff` | 中性表面（输入框、模态层底） |
| `--card`               | `#ffffff` | 卡片底色                     |
| `--card-foreground`    | `#1a2942` | 卡片文字                     |
| `--popover`            | `#ffffff` | 浮层底色（菜单/Tooltip）     |
| `--popover-foreground` | `#1a2942` | 浮层文字                     |
| `--muted`              | `#f1eee5` | 次级灰底（占位、tag 静态态） |
| `--muted-foreground`   | `#6b7280` | 次级文字（时间戳、辅助说明） |

### 2.2 Brand（品牌色）

| Token                  | Hex       | 用途                           |
| ---------------------- | --------- | ------------------------------ |
| `--primary`            | `#0e7fbf` | 主功能色（CTA、链接、选中态）  |
| `--primary-foreground` | `#ffffff` | 主功能色之上文字               |
| `--default`            | `#1a2942` | 默认实体（深色按钮、强调标签） |
| `--default-foreground` | `#ffffff` | default 之上文字               |

### 2.3 Semantic（语义色）

| Token                      | Hex       | 用途                                                |
| -------------------------- | --------- | --------------------------------------------------- |
| `--secondary`              | `#fff3e0` | 次要高亮底（被选会话项底色）                        |
| `--secondary-foreground`   | `#8a4a18` | 次要高亮上文字                                      |
| `--accent`                 | `#f59e0b` | 强调（落日橙）：工具运行中、需用户决策（Interrupt） |
| `--accent-foreground`      | `#ffffff` | accent 上反白文字                                   |
| `--destructive`            | `#fee2e2` | 危险底色（删除按钮 hover、错误提示底）              |
| `--destructive-foreground` | `#b91c1c` | 危险文字                                            |

### 2.4 Form（表单与边线）

| Token                  | Hex       | 用途                          |
| ---------------------- | --------- | ----------------------------- |
| `--border`             | `#e5dfd1` | 默认描边（卡片、输入框）      |
| `--input`              | `#f5f1e8` | 输入框底色                    |
| `--ring`               | `#0e7fbf` | focus ring 颜色（同 primary） |
| `--button-bg-disabled` | `#e5dfd1` | 按钮 disabled 底              |

### 2.5 Sidebar（左侧边栏专属）

| Token                          | Hex       | 用途                                     |
| ------------------------------ | --------- | ---------------------------------------- |
| `--sidebar`                    | `#fbf6ec` | 侧栏底色（比 background 略深，区隔主区） |
| `--sidebar-primary`            | `#0e7fbf` | 侧栏主色（如品牌区）                     |
| `--sidebar-primary-foreground` | `#ffffff` | 侧栏主色文字                             |
| `--sidebar-accent`             | `#fff3e0` | 选中会话项底色                           |
| `--sidebar-accent-foreground`  | `#8a4a18` | 选中会话项文字                           |
| `--sidebar-border`             | `#ece4d2` | 侧栏分割线                               |
| `--sidebar-ring`               | `#0e7fbf` | 侧栏 focus ring                          |
| `--sidebar-button-hover`       | `#f3ecdc` | 会话项 hover 底色                        |
| `--sidebar-weak`               | `#b8a988` | 侧栏弱化文字（描述文案）                 |

### 2.6 Chart（图表/数据可视化）

| Token       | Hex       | 寓意                  |
| ----------- | --------- | --------------------- |
| `--chart-1` | `#0e7fbf` | 海蓝（主序列）        |
| `--chart-2` | `#f59e0b` | 落日橙                |
| `--chart-3` | `#d4a574` | 沙金（行程/景点标签） |
| `--chart-4` | `#2d8659` | 椰绿（成功、已完成）  |
| `--chart-5` | `#9b5de5` | 晚霞紫                |

### 2.7 Icon & Label（图标与标签）

| Token                    | Hex       | 用途                           |
| ------------------------ | --------- | ------------------------------ |
| `--icon-dark`            | `#1a2942` | 图标主色（与 foreground 一致） |
| `--icon-light`           | `#6b7280` | 图标次色                       |
| `--icon-text-dark`       | `#4b5563` | 图标旁的标签文字               |
| `--icon-weak`            | `#9ca3af` | 弱化图标（占位、空态）         |
| `--icon-g-ten`           | `#d1d5db` | 极弱图标（分割图标）           |
| `--label-text`           | `#1a2942` | 标签文字主色                   |
| `--label-foreground`     | `#ffffff` | 标签反白文字                   |
| `--label-sec-foreground` | `#8a4a18` | 次级标签文字                   |
| `--title-default`        | `#1a2942` | 标题默认色                     |

---

## 3. Typography

### 3.1 字体族

```css
--font-sans:
  -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
  "Microsoft YaHei", Roboto, sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
```

### 3.2 字号阶梯

| Token       | px  | 用途                     |
| ----------- | --- | ------------------------ |
| `text-xs`   | 12  | 时间戳、徽章、token 计数 |
| `text-sm`   | 13  | 会话项标题、辅助文案     |
| `text-base` | 14  | 消息正文（默认）         |
| `text-md`   | 16  | 输入框、按钮文字         |
| `text-lg`   | 20  | 模块标题、ChatHeader     |
| `text-xl`   | 24  | 主标题（如有）           |
| `text-2xl`  | 32  | 着陆页大标题             |

### 3.3 行高与字重

- 正文：`line-height: 1.6`
- 标题：`line-height: 1.5`
- 字重：常规 400 / 中等 500（强调 / 选中态） / 半粗 600（徽章 / 标题）

---

## 4. Spacing

4px 基准，阶梯：**4 / 8 / 12 / 16 / 20 / 24 / 32 / 48**。

| 场景                              | 值                       |
| --------------------------------- | ------------------------ |
| 紧凑组件内距（tag / chip）        | 4–6px 垂直，10–12px 水平 |
| 输入框/按钮内距                   | 10px 垂直，12–20px 水平  |
| 卡片/消息气泡内距                 | 10–14px                  |
| 区块间距（消息之间）              | 10–12px                  |
| 区域内边距（chat-area / sidebar） | 16px                     |

---

## 5. Radius

| Token          | px  | 用途                          |
| -------------- | --- | ----------------------------- |
| `rounded-sm`   | 6   | 小标签、徽章                  |
| `rounded-md`   | 8   | 输入框、按钮、会话项          |
| `rounded-lg`   | 12  | 消息气泡、卡片、聊天容器      |
| `rounded-xl`   | 18  | Interrupt 选项胶囊            |
| `rounded-pill` | 999 | 完全胶囊（标签、Header chip） |

气泡尾角处理：用户气泡右下 `4px`，AI 气泡左下 `4px`（保留即时通讯感）。

---

## 6. Elevation / Shadow

3 级 + 1 个旅游主题"晨雾"软阴影：

```css
--shadow-subtle: 0 1px 2px 0 rgb(26 41 66 / 0.04);
--shadow-card:
  0 2px 8px -2px rgb(26 41 66 / 0.06), 0 4px 16px -4px rgb(26 41 66 / 0.04);
--shadow-popover:
  0 8px 24px -4px rgb(26 41 66 / 0.12), 0 2px 6px -2px rgb(26 41 66 / 0.06);
/* 旅游主题晨雾光晕：用于 hover 浮起或主 CTA */
--shadow-mist: 0 4px 20px -6px rgb(14 127 191 / 0.18);
```

---

## 7. Components

### 7.1 Button

| Variant     | bg                                  | fg                                                      | border     | 用途             |
| ----------- | ----------------------------------- | ------------------------------------------------------- | ---------- | ---------------- |
| primary     | `--primary`                         | `--primary-foreground`                                  | none       | "新对话"、"发送" |
| secondary   | `--secondary`                       | `--secondary-foreground`                                | none       | 次级操作         |
| ghost       | transparent                         | `--foreground`                                          | `--border` | 工具栏图标按钮   |
| destructive | transparent → hover `--destructive` | `--muted-foreground` → hover `--destructive-foreground` | none       | 删除会话         |

尺寸（高度 / padding-x）：`sm 28/12` `md 36/16` `lg 40/20`，圆角 `rounded-md`，过渡 `150ms ease-in-out`，disabled `--button-bg-disabled` + `cursor: not-allowed`。

### 7.2 Input

- 高度 40，padding `10px 12px`，圆角 `rounded-md`，背景 `--input`，描边 `--border`
- focus：描边切到 `--ring`，外加 2px halo `color-mix(in srgb, var(--ring) 18%, transparent)`

### 7.3 Card

- 背景 `--card`，描边 `1px --border`，圆角 `rounded-lg`，padding 16，阴影 `--shadow-card`

### 7.4 Message Bubble

| 角色      | bg                                                   | fg                     | border         | 备注                                                                 |
| --------- | ---------------------------------------------------- | ---------------------- | -------------- | -------------------------------------------------------------------- |
| user      | `--primary`                                          | `--primary-foreground` | none           | 右对齐，右下 4px                                                     |
| assistant | `--card`                                             | `--card-foreground`    | `1px --border` | 左对齐，左下 4px                                                     |
| interrupt | `color-mix(in srgb, var(--accent) 10%, var(--card))` | `--card-foreground`    | `1px --accent` | 顶部带 `interrupt-badge`（`--accent` 底 + `--accent-foreground` 字） |
| loading   | `--card`                                             | `--muted-foreground`   | `1px --border` | 文字斜体                                                             |

最大宽度 80%，圆角 `rounded-lg`，行高 1.6。

### 7.5 Tool Tag（工具调用）

| 状态    | bg                                                    | fg                   | border                                                    | 动效                              |
| ------- | ----------------------------------------------------- | -------------------- | --------------------------------------------------------- | --------------------------------- |
| idle    | `--muted`                                             | `--muted-foreground` | `1px --border`                                            | 无                                |
| running | `color-mix(in srgb, var(--accent) 12%, var(--card))`  | `--accent`           | `1px --accent`                                            | `pulse 1.5s ease-in-out infinite` |
| done    | `color-mix(in srgb, var(--chart-4) 10%, var(--card))` | `--chart-4`          | `1px color-mix(in srgb, var(--chart-4) 35%, var(--card))` | 无                                |

尺寸：高 24，padding `4px 10px`，圆角 `rounded-sm`，字号 12，字重 500。

### 7.6 Sidebar Item（会话项）

- 默认：透明底，`--foreground` 文字
- hover：`--sidebar-button-hover` 底
- active：`--sidebar-accent` 底，标题色 `--sidebar-accent-foreground`，字重 500
- 删除按钮 hover：底 `--destructive`，色 `--destructive-foreground`
- token 徽章：底 `--secondary`，字 `--primary`，字号 10，圆角 4

### 7.7 Interrupt Option Chip

- 高 30，padding `6px 16px`，圆角 `rounded-xl`（18）
- 默认：`--card` 底 + `1px --accent` + `--accent` 文字
- hover：`--accent` 底 + `--accent-foreground` 文字
- active：`scale(0.96)`
- disabled：`opacity: 0.5`

---

## 8. Motion

```css
--transition-fast: 150ms ease-in-out;
--transition-base: 200ms ease-in-out;
--transition-slow: 300ms ease-in-out;
```

- 颜色 / 背景 / 边框过渡：`transition-fast`
- 进入动画：opacity + 4px 上移，`transition-base`
- 工具运行：`pulse 1.5s ease-in-out infinite`，opacity 1 ↔ 0.6

```css
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}
```

---

## 9. Guidelines

### 9.1 颜色使用守则（强制）

- **禁止**任何写死 hex（除本文件 / `tailwind.css` 与历史 fallback 注释外）
- 必须使用 `var(--xxx)`；Tailwind 中等价为 `bg-primary` / `text-foreground` / `border-border` 等（见 `@theme inline` 桥接）
- 半透叠加用 `color-mix(in srgb, var(--xxx) N%, var(--card))`，不要写 `rgba(14,127,191,0.1)`

### 9.2 信息层级

1. **海蓝 `--primary`** —— 唯一 CTA、唯一选中态；一个视图最多 1 处主色按钮
2. **落日橙 `--accent`** —— 仅用于"需要注意 / 进行中 / 等待用户"
3. **沙金 `--chart-3`** —— 行程/景点/地点类元数据标签
4. **椰绿 `--chart-4`** —— "完成 / 成功"
5. **米白 / 沙底** —— 大面积留白，撑起阳光感

### 9.3 旅游主题表达

- 推荐图卡圆角统一 `rounded-lg`，描边浅，靠 `--shadow-mist` 营造海雾光晕
- 行程时间线用 `--chart-3` 沙金竖线 + `--primary` 节点圆点
- 空态插画使用渐变 `--background → --secondary`，不要纯白

### 9.4 文件入口

- Token：`web/src/styles/tailwind.css`
- 全局样式：`web/src/App.css`（仅引用 token，不可写死颜色）
- 组件级样式：组件目录内 `*.module.css` 或 Tailwind utility class，统一引用 token

---

## 10. Roadmap（与本 DESIGN.md 配套的迭代）

- v0.1 (current)：Token 落地 + App.css 颜色全部走变量
- v0.2：组件级 Tailwind utility 重构（MessageBubble / Sidebar / InputBar）
- v0.3：抽出基础组件 `Button` / `Card` / `Tag` / `Chip`
- v0.4：补 `.dark` 极光风暗色主题（仅替换 token 值，不改命名）
