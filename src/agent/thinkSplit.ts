/**
 * Task 4.1 — `<think>...</think>` 流式切分状态机
 *
 * 规划:docs/开发规划.md Task 4.1(思考过程独立化,把 reasoning 跟 answer 拆开)
 * 八股:09-Prompt工程.md §4 CoT(reasoning 与 answer 的边界控制)
 *
 * 背景:
 * - MiniMax 走 OpenAI 兼容协议时,把 reasoning 当作 `<think>...</think>` 内联进 content 字段
 *   (不像 DeepSeek/xAI 用独立 `reasoning_content` 字段),LangChain 不会自动分离
 * - 流式场景下,`<think>` / `</think>` 标签可能被切在两个 chunk 之间,
 *   不能简单用 string.split—— 必须状态机维持跨调用的 buffer
 *
 * 设计:函数纯函数 + 显式 state,每次调用 (state, newChunk) → (newState, segments[])
 * - state.mode:'text' | 'think' — 当前在标签外还是标签内
 * - state.tail:未消费的尾部字符串(可能是 `<th` 部分标签 / `</thi` 等)
 *
 * 边界覆盖(4 种):
 *   ① 完整 `<think>X</think>` 在一个 chunk 内
 *   ② `<think>` 跨 chunk:`...<th` + `ink>...`
 *   ③ think 内部跨 chunk:`<think>part1` + `part2`
 *   ④ `</think>` 跨 chunk:`...</thi` + `nk>...`
 */

export type ThinkMode = 'text' | 'think'

export type ThinkSplitState = {
  /** 当前在 think 标签外还是内 */
  mode: ThinkMode
  /** 尾部未消费的字符串 — 可能是 `<th` 这种"疑似标签开头但还没完整"的片段 */
  tail: string
}

export type ThinkSegment =
  | { kind: 'text'; value: string }
  | { kind: 'think'; value: string }

export function createThinkSplitState(): ThinkSplitState {
  return { mode: 'text', tail: '' }
}

const OPEN_TAG = '<think>'
const CLOSE_TAG = '</think>'

/**
 * 喂入一段新 chunk,产出零个或多个 segment,并更新 state。
 *
 * 注意:不会主动 flush 残留 tail —— 如果 chunk 在 `<th` 处结束,tail 保留;
 * 调用方在流末必须调 flushThinkSplit(state) 把 tail 当作 text(或 think)输出。
 */
export function feedThinkSplit(
  state: ThinkSplitState,
  chunk: string
): { segments: ThinkSegment[]; state: ThinkSplitState } {
  const segments: ThinkSegment[] = []
  let buf = state.tail + chunk
  let { mode } = state

  while (buf.length > 0) {
    if (mode === 'text') {
      const openIdx = buf.indexOf(OPEN_TAG)
      if (openIdx === -1) {
        // 没找到 `<think>`,但可能存在"疑似前缀"(末尾是 `<` / `<t` / `<th` 等)
        // 把"疑似前缀"留在 tail,前面的部分作为 text emit
        const cut = trailingPartialTag(buf, OPEN_TAG)
        if (cut > 0) {
          emitText(segments, buf.slice(0, cut))
        }
        buf = buf.slice(cut)
        // 此时 buf 全部是"疑似 <think> 前缀",留 tail 等下次
        break
      }
      // 找到 `<think>`:emit 前段 text → 切换 mode → 继续处理后段
      if (openIdx > 0) emitText(segments, buf.slice(0, openIdx))
      buf = buf.slice(openIdx + OPEN_TAG.length)
      mode = 'think'
    } else {
      const closeIdx = buf.indexOf(CLOSE_TAG)
      if (closeIdx === -1) {
        // think 内,没找到 `</think>`,同样判"疑似闭合前缀"
        const cut = trailingPartialTag(buf, CLOSE_TAG)
        if (cut > 0) {
          emitThink(segments, buf.slice(0, cut))
        }
        buf = buf.slice(cut)
        break
      }
      if (closeIdx > 0) emitThink(segments, buf.slice(0, closeIdx))
      buf = buf.slice(closeIdx + CLOSE_TAG.length)
      mode = 'text'
    }
  }

  return { segments, state: { mode, tail: buf } }
}

/**
 * 流末调用:把 state.tail 残留(可能是 `<th` 这种不完整标签前缀)按当前 mode emit。
 * 不抛错——残留按字面文本处理,因为流可能在标签真正闭合前断开。
 */
export function flushThinkSplit(
  state: ThinkSplitState
): { segments: ThinkSegment[]; state: ThinkSplitState } {
  const segments: ThinkSegment[] = []
  if (state.tail.length > 0) {
    if (state.mode === 'text') {
      emitText(segments, state.tail)
    } else {
      emitThink(segments, state.tail)
    }
  }
  return { segments, state: { mode: state.mode, tail: '' } }
}

// ── 内部 helper ──

// 不做合并:adapter 多 yield 几次 THINKING_CONTENT 事件,前端按事件累加即可。
// 合并语义容易踩"中间经过 mode 切换但没 emit 出 segment(空字符串跳过了)→ 错误合并"的坑(实测 ⑪)。
function emitText(segments: ThinkSegment[], value: string): void {
  if (value.length === 0) return
  segments.push({ kind: 'text', value })
}

function emitThink(segments: ThinkSegment[], value: string): void {
  if (value.length === 0) return
  segments.push({ kind: 'think', value })
}

/**
 * 返回应当作为"已确定不是标签前缀"的尾切点位置。
 * 例:tag='<think>',buf 末尾是 '<th' → 返回 buf.length - 3(保留 '<th' 在 tail)。
 * 如果 buf 末尾不是 tag 前缀,返回 buf.length(全 emit)。
 */
function trailingPartialTag(buf: string, tag: string): number {
  const max = Math.min(buf.length, tag.length - 1)
  for (let n = max; n > 0; n--) {
    if (buf.endsWith(tag.slice(0, n))) {
      return buf.length - n
    }
  }
  return buf.length
}
