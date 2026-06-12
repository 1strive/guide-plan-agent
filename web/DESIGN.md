# 路书 Design System

> 单文件设计系统。任何 AI 编码工具读取本文件后，都应直接据此生成符合视觉与交互规范的 UI。
> Token 源文件：`web/src/styles/tailwind.css`

---

## 1. Brand & Tone

**产品定位**：旅游规划 Agent「路书」，主线场景为对话式旅行规划与目的地推荐。

**视觉关键词**：温暖赤陶、深色侧边栏、现代简约、人文气质。

**语气与情绪**：

- 亲切但专业，像一位熟悉本地的向导
- 信息密度优先于装饰；颜色与动效都为"指引视线"服务
- 用色谨慎：赤陶色为主功能色（CTA、链接、选中），蓝色仅用于思考过程

**Do / Don't**：

- DO：暖白底 + 深色侧边栏 + 赤陶色点缀
- DO：用沙金色（chart-3）做"行程/景点"类信息标签
- DON'T：在普通卡片上叠多种暖色
- DON'T：写死任何 hex —— 必须使用 `var(--xxx)`

---

## 2. Colors

所有颜色以 CSS 变量声明在 `web/src/styles/tailwind.css` 的 `:root` 下。

### 2.1 Surface

| Token | Hex | 用途 |
|-------|-----|------|
| `--background` | `#f8f5f0` | 全局页面底色（暖白） |
| `--foreground` | `#2a2725` | 全局文字主色（深炭灰） |
| `--surface` | `#ffffff` | 中性表面（输入框、卡片底） |
| `--surface-alt` | `#f2eeea` | 次级表面 |
| `--card` | `#ffffff` | 卡片底色 |
| `--muted` | `#f2eeea` | 次级灰底 |
| `--muted-foreground` | `#706b66` | 次级文字 |

### 2.2 Brand

| Token | Hex | 用途 |
|-------|-----|------|
| `--primary` | `#c4513a` | 主功能色（赤陶） |
| `--primary-foreground` | `#fcfcfc` | 主色之上文字 |
| `--accent` | `#c4513a` | 强调色（同主色） |
| `--accent-soft` | `#f5e6e2` | 柔和强调底 |
| `--accent-hover` | `#b3432d` | 强调色 hover |
| `--success` | `#2d8a55` | 成功/已完成 |

### 2.3 Sidebar（深色）

| Token | Hex | 用途 |
|-------|-----|------|
| `--sidebar` | `#302c2a` | 侧栏底色（深炭） |
| `--sidebar-fg` | `#f2eeea` | 侧栏文字 |
| `--sidebar-muted` | `#9e9791` | 侧栏弱化文字 |
| `--sidebar-hover` | `#3d3835` | 侧栏 hover |
| `--sidebar-active` | `#4d3f38` | 选中项底色 |
| `--sidebar-border` | `#292524` | 侧栏分割线 |

### 2.4 Message

| Token | Hex | 用途 |
|-------|-----|------|
| `--user-bg` | `#c4513a` | 用户气泡底（同主色） |
| `--user-fg` | `#fcfcfc` | 用户气泡文字 |
| `--think-bg` | `#eff2f6` | 思考块底色（冷蓝灰） |
| `--think-accent` | `#5e7ea6` | 思考块标题色 |
| `--think-border` | `#d4dce6` | 思考块边框 |
| `--think-content` | `#5a6370` | 思考块内容色 |

### 2.5 Form & Border

| Token | Hex | 用途 |
|-------|-----|------|
| `--border` | `#e4dfda` | 默认描边 |
| `--border-strong` | `#ccc6c0` | 加强描边 |
| `--input` | `#f2eeea` | 输入框底色 |
| `--ring` | `#c4513a` | focus ring |

---

## 3. Typography

### 3.1 字体族

```css
--font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC",
  "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;
--font-mono: "SF Mono", "JetBrains Mono", "Menlo", ui-monospace, monospace;
```

### 3.2 字号阶梯

| px | 用途 |
|----|------|
| 11 | 时间戳、分组标签、badge |
| 12 | 发送者标签、toolbox 按钮 |
| 13 | 会话标题、思考块、快捷芯片 |
| 14 | 消息正文（默认） |
| 15 | ChatHeader 标题、品牌名 |
| 20 | 欢迎标题 |

---

## 4. Radius

| Token | px | 用途 |
|-------|----|------|
| `--radius-sm` | 8 | 小按钮、badge |
| `--radius-md` | 12 | 输入框、think 块 |
| `--radius-lg` | 16 | 消息气泡、输入卡片 |
| `--radius-xl` | 18 | 选项胶囊 |
| 999 | 完全胶囊（快捷回复、chip） |

---

## 5. Shadow

```css
--shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
--shadow-card: 0 4px 12px rgba(0,0,0,0.08);
--shadow-popover: 0 8px 24px -4px rgb(42 39 37/0.12), 0 2px 6px -2px rgb(42 39 37/0.06);
--shadow-mist: 0 4px 20px -6px rgb(196 81 58/0.18);
```

---

## 6. Layout

### 6.1 侧边栏（320px, 深色）

- 品牌区: logo 图标 + "路书" + "旅行规划助手"
- 新建按钮: 全宽赤陶色 "开始新旅行"
- 搜索框: 深色输入框（客户端过滤）
- 分组列表: 今天/昨天/近 7 天/更早
- 会话项: 地图钉图标 + 标题 + 预览；选中项左侧 3px 赤陶条
- 用户 footer: 头像 + 用户名 + 版本

### 6.2 主区域

- ChatHeader: 会话标题 + 状态指示器 + 操作按钮
- MessageList: 开放式滚动区域，max-width 760px 居中
- InputBar: 圆角卡片式 textarea + 工具栏

### 6.3 消息布局

- **用户**: 右对齐赤陶色气泡，max-width 560px
- **助手**: 头像 + 发送者标签 + 内容流（think → text → tools → interrupt → toolbox → quick replies）

---

## 7. Components

### 7.1 ThinkingBlock

- 冷蓝灰底色面板，带灯泡图标 + "思考过程" 标签 + 折叠箭头
- useState 控制开合，max-height + opacity 过渡动画
- 默认展开

### 7.2 TextContent（Markdown）

- 使用 react-markdown + remark-gfm 渲染
- 支持标题、列表、加粗、代码块、表格、引用
- 通过 Tailwind arbitrary variants 定制排版

### 7.3 Toolbox

- 复制按钮，默认半透明，hover 时全显
- 使用 group-hover 跟随父消息 hover 状态

### 7.4 QuickReplies

- 助手消息后的快捷回复芯片
- 胶囊形状，hover 时边框变赤陶色 + 柔和底

### 7.5 InputBar

- textarea 自动伸缩（min 48px, max 160px）
- 圆角卡片包裹，focus-within 边框变赤陶色
- 底部工具栏: 上传/位置/语音图标 + 发送按钮
- Enter 发送, Shift+Enter 换行

---

## 8. Guidelines

### 8.1 颜色使用守则（强制）

- **禁止**任何写死 hex
- 必须使用 `var(--xxx)` 或 Tailwind 工具类（`bg-primary` / `text-foreground` 等）
- 半透叠加用 `color-mix(in srgb, var(--xxx) N%, var(--card))`

### 8.2 信息层级

1. **赤陶 `--primary`** — 唯一 CTA、唯一选中态
2. **冷蓝 `--think-accent`** — 思考过程专用
3. **沙金 `--chart-3`** — 行程/景点标签
4. **绿 `--success`** — 完成/成功
5. **暖白** — 大面积留白

### 8.3 文件入口

- Token：`web/src/styles/tailwind.css`
- 全局样式：`web/src/App.css`
- 图标：`web/src/components/Icons.tsx`
- 组件：`web/src/components/`、`web/src/Conversation/`、`web/src/ChatInput/`
