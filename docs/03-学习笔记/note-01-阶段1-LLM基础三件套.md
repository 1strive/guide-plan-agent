# 阶段1 学习笔记:LLM 基础三件套

> **本文目标**:把阶段1 学习路线里的三件核心概念——Transformer/Self-Attention、Token/Tokenizer、推理参数——和**已经写出来的代码**绑在一起讲清楚。读完你应该能:面试时不打哑、改代码时知道每个参数在动什么、读八股 07/09 不再吃力。
>
> **读者画像**:全栈背景的前端工程师,LLM 底层薄弱。所有解释优先用工程类比,公式只在必要时出现。
>
> **关联**:
> - 规划:`docs/开发规划.md` 阶段1(已完成)
> - 八股:`docs/01-面试八股文/07-大模型基础.md` Transformer/Attention/Token、`09-Prompt工程.md` §2.4 推理参数
> - 代码:`src/agent/llm.ts`、`src/agent/token-usage.ts`、`src/config.ts`

---

## 引言:你已经写了什么,但还没"理解"什么

阶段1 你已经在代码里调用了这些概念:

| 你写的代码 | 涉及的 LLM 概念 | 当前理解程度 |
|----------|---------------|-------------|
| `postChatStream` 把 fetch 响应一行行解析 | LLM 输出是**流式 token** | ✅ 工程上会用 |
| `stream_options.include_usage` 拿回 `prompt_tokens / completion_tokens` | Token 计费的最小粒度 | ⚠️ 知道有,不知 token 是什么 |
| `estimateTokens(text) = ceil(length / 2)` 字符近似 | Tokenizer 的字符密度 | ⚠️ 公式拍脑袋,不知原理 |
| `LLM_TEMPERATURE / LLM_TOP_P / LLM_MAX_TOKENS` 透传 | 推理时采样参数 | ⚠️ 配置项,不知道动了什么 |

**阅读路径建议**:
- 完全没有算法基础(神经网络是什么、RNN 听过没用过) → **先读"前置章节"**
- 知道神经网络大致是啥、听过 RNN 但说不清原理 → **快速扫前置,精读后续三节**
- 受过系统 ML 训练 → **跳过前置,直接进第一部分**

---

## 前置章节:零基础速通 — 神经网络与序列模型简史

> 目标:让你能从"神经网络是什么"一直读到"为什么 Transformer 来了",中间不出现任何没解释的术语。
> 风格:工程类比为主,公式只在能省事时出现。

### 0.1 神经网络是什么 — 一个超大的可学习函数

剥光了说,神经网络就是一个**输入 → 输出的纯函数**:

```
f(input) = output
```

特别之处只有两点:

1. **它非常复杂**——内部有几百万到几千亿个**可调参数**(GPT-3 是 1750 亿)。
2. **这些参数不是程序员写死的,是"训练"出来的**——给它一堆"输入 + 期望输出"的样本,它自己慢慢调,直到 f(input) 越来越接近期望输出。

> **前端类比**:你写过的所有 `function fn(x) { ... }` 里的常量都是你拍脑袋定的;神经网络是把这些常量抽成"未知参数",交给一个自动调参流程去找最优值。最终你拿到的是**一个调好的函数,但它的内部参数没人能解读**。

### 0.2 神经元 — 最小的"零件"

一个神经元做的事极其简单:

```
output = activation(weight * input + bias)
```

`weight`(权重)和 `bias`(偏置)是这个神经元的两个参数。`activation` 是个固定的非线性函数,常见的是 **ReLU**:

```javascript
const relu = (x) => Math.max(0, x)
// 完整神经元
const neuron = (input, weight, bias) => relu(weight * input + bias)
```

**为什么需要 activation?** 没有它,无论你叠多少层,整个网络等价于一个线性函数,表达不了复杂关系。activation 是引入"非线性"的关键。

### 0.3 神经网络 = 神经元层层堆叠

```
输入层  ─→  隐藏层 1  ─→  隐藏层 2  ─→  ...  ─→  输出层
[x1,x2]    [n1...n100]   [n1...n100]            [y1,y2,y3]
            ↑              ↑
        每个 ni 都连接上一层所有节点,各自带 weight + bias
```

层数多 = 深度 = "**深度**学习"的"深度"由来。

### 0.4 训练 — 像"自动 git bisect"

你给网络一堆"问题 + 标准答案"(训练样本),训练流程是:

```
1. 前向传播 (forward pass)
   把 input 喂进去,逐层计算,得到 output
   
2. 计算损失 (loss)
   loss = 距离(output, 期望答案)
   比如分类任务用 cross-entropy,回归任务用 MSE
   loss 越小说明网络越接近正确答案

3. 反向传播 (backpropagation)
   从 loss 反推:每个权重应该往哪个方向(增/减)调,调多少?
   这个"方向 + 大小"叫梯度 (gradient)
   
4. 梯度下降 (gradient descent)
   按梯度调整每个权重: weight -= learning_rate * gradient
   
5. 拿下一批样本,回到 1
```

**类比**:像在山上找最低点,每次看脚下哪边更低就往哪边迈一小步。loss 是海拔,梯度是坡度方向。重复百万次,网络就"学会了"。

> 这一节理解到这里就够了。涉及的链式求导、反向传播算法你**不需要会推**——99% 的工程师调 API 用不上这些。

### 0.5 为什么文字数据需要"序列模型"

普通神经网络(MLP / CNN)适合**固定大小、无序**的输入:
- 一张 224×224 图片 → 50176 个像素一次性喂进去
- 一行表格数据 → 列数固定

但**文字、语音、时间序列**是:
- **有先后顺序**("不喜欢"和"喜欢不"意思相反)
- **长度不固定**(一句话 5 字,一篇文章 5000 字)

普通 MLP 没法处理变长数据。需要专门为"序列"设计的架构——这就是 **RNN / LSTM / Transformer** 的共同动机。

### 0.6 RNN(循环神经网络) — 2014 时代主力

**核心想法**:一个**带"记忆"**的小神经网络,**对每个 token 复用同一组参数**。

```
读"今天":     memory_1 = transform(memory_0, "今天")
读"天气":     memory_2 = transform(memory_1, "天气")
读"真":       memory_3 = transform(memory_2, "真")
读"好":       memory_4 = transform(memory_3, "好")
                                ↑
                          memory_4 包含了对整句话的"理解"
```

**前端类比**(React/Redux 风格):

```typescript
// memory 在 React 里就是 useState 里的状态
let memory = initialMemory  // 比如全 0 向量
for (const token of sequence) {
  memory = transform(memory, token)  // transform 是个小神经网络,参数固定
}
return memory  // 最终状态代表整句的"理解"
```

数学版(看不懂可以跳过):

```
h_t = tanh(W·x_t + U·h_{t-1} + b)
        ↑     ↑      ↑
      新输入 上一刻状态 同一组参数复用所有时间步
```

**关键点**:
- W、U、b 是这个 RNN 的全部参数,所有时间步**共享同一份**
- 参数共享 = 模型小 + 能处理任意长度

### 0.7 RNN 的两个致命伤(为什么后来被淘汰)

#### 伤一:梯度消失/爆炸 → 长距离信息丢失

反向传播时,误差从最后一个时间步往前传,**每经过一步要被乘一次权重矩阵**。如果权重平均小于 1:

```
原始误差: 1.0
经过 1 步: 0.5
经过 2 步: 0.25
...
经过 20 步: 0.0000009  ← 几乎为 0,前面的权重学不到东西
```

这就是**梯度消失**。如果权重大于 1 则反过来,**梯度爆炸**(数值溢出)。

**工程后果**:句首的"猫"无法影响句末的代词"它"——RNN 看长句子就"忘了开头说什么"。

#### 伤二:串行计算,GPU 用不上

`memory_t` 必须等 `memory_{t-1}` 算完才能开始,**没法并行**。GPU 数千核心一起摆烂,只能一个时间步一个时间步排队走。**训练慢得令人发指**。

### 0.8 LSTM(长短期记忆网络) — RNN 的"加强版"

LSTM 是 1997 年提出的,但 2014 年后大火。它在 RNN 基础上加了"**门控机制**"——**让网络自己学习"该记什么、忘什么、输出什么"**。

#### 三道门

每道"门"是一组 0~1 的值(由一个小神经网络从当前输入和上一时刻状态算出),作用是**乘到对应数据上,实现"软开关"**:

```
gate = sigmoid(...)       // 输出 0~1
result = gate * data      // gate=0 全屏蔽, gate=1 全保留, gate=0.5 减半
```

LSTM 的三道门:
- **遗忘门(Forget Gate)**:多大比例**忘掉**老记忆
- **输入门(Input Gate)**:多大比例**接收**新信息进入记忆
- **输出门(Output Gate)**:多大比例的内部记忆**对外输出**

#### 前端类比(reducer 风格)

```typescript
function lstmStep(prev, newInput) {
  const forget = sigmoid(Wf * [prev.hidden, newInput] + bf)  // 该忘多少?
  const input  = sigmoid(Wi * [prev.hidden, newInput] + bi)  // 该收多少?
  const output = sigmoid(Wo * [prev.hidden, newInput] + bo)  // 该出多少?
  
  const candidate = tanh(Wc * [prev.hidden, newInput] + bc)
  
  // cell 是"长期记忆",有一条几乎不变的"高速公路"
  const cell = forget * prev.cell + input * candidate
  
  // hidden 是"短期对外输出"
  const hidden = output * tanh(cell)
  
  return { cell, hidden }
}
```

#### LSTM 解决了什么、没解决什么

✅ **解决**:`cell` 状态有一条"几乎不被改动"的传递路径(forget=1, input=0 时直接复制),梯度沿这条路径反传时不会快速消失 → **长距离依赖问题大幅缓解**。

❌ **没解决**:仍然是按时间步串行计算,**还是慢**。

### 0.9 GRU(门控循环单元) — LSTM 的精简版

2014 年提出,把 LSTM 的 3 门简化到 2 门(reset + update),参数少 25%,效果接近 LSTM,在中小数据集常被作为更轻量替代。**和 LSTM 是同一时代的"修补方案"**。

### 0.10 Encoder-Decoder + Attention(2014~2016 的过渡)

机器翻译这种"输入是英文、输出是中文"的任务催生了 **Encoder-Decoder** 架构:

```
英文句子 → [Encoder RNN] → 一个固定向量 → [Decoder RNN] → 中文句子
```

但**用一个固定向量代表整句话信息丢失太严重**。2014 年 Bahdanau 等人提出在 Decoder 里加 **Attention**:**解码每个词时,回看 Encoder 所有时间步,加权聚合**。

```
正在解码"weather"时,Attention 权重:
  [今天: 0.05, 天气: 0.85, 真: 0.05, 好: 0.05]
                  ↑
        模型自己学会:翻"weather"该看"天气"
```

**这是 Attention 思想的最早形态**——但还是嵌在 RNN 框架里,串行问题没解决。

### 0.11 Transformer(2017) — "Attention is All You Need"

研究者发现:**既然 Attention 这么强,为什么还要 RNN?**

于是在 2017 年的论文里**直接砍掉 RNN**,纯用 Attention 处理序列。一举解决两大顽疾:

| 问题 | RNN/LSTM | Transformer |
|------|---------|------------|
| 长距离依赖 | 梯度消失,远的记不住 | 任意两 token 直接 attention,**距离无关** |
| 并行计算 | 必须按时间步串行 | 所有 token 一起算,**完全并行** |
| 复杂度 | O(n) 时间但难加速 | O(n²) 时间但完全并行,**实际更快** |

代价:**没有"先后顺序"概念了**——所有 token 一起处理,模型不知道谁在前。解决方法:**位置编码(Positional Encoding)**,给每个 token 加一个"位置标签"向量。

### 0.12 时代脉络一图速记

```
1957  感知机 (Perceptron)            ─ 最早的人工神经元
1986  反向传播算法 (Backprop)        ─ 训练深层网络成为可能
1997  LSTM                           ─ 解决 RNN 的长距离问题
2012  AlexNet                        ─ CNN 在图像识别上爆发
2014  Seq2Seq + Attention            ─ 翻译任务,Attention 雏形
2017  Transformer ★                  ─ "Attention is all you need"
2018  GPT-1 / BERT                   ─ Transformer 用于预训练
2020  GPT-3 (175B 参数)              ─ 涌现能力 (in-context learning)
2022  ChatGPT (GPT-3.5 + RLHF)       ─ 人类反馈对齐,引爆全民
2023  GPT-4 / Claude 2 / LLaMA       ─ 开源闭源百花齐放
2024  Claude 3.5 / GPT-4o / o1       ─ 多模态、推理能力
                                       ↑
                                  你正在用的
```

### 0.13 读完前置你应该能回答

- 神经网络本质上是什么?(一个超大的可学习函数)
- 一个神经元在算什么?(`activation(w·x + b)`)
- 训练做的是什么事?(自动调权重让 loss 变小)
- RNN 的核心思想?(带"记忆"的小网络,对每个 token 复用)
- RNN 的两个致命问题?(梯度消失 + 串行)
- LSTM 怎么改进 RNN 的?(三道门控制记忆流)
- 为什么 Transformer 能取代 LSTM?(并行 + 长距离依赖一并解决)

如果以上能用自己的话说出来,继续读第一部分会非常顺。如果有卡壳,**回到对应小节再读一遍**——后面三个核心部分都建立在这些基础上。

---

## 第一部分:Transformer 与 Self-Attention

### 1.1 为什么 Transformer 取代了 RNN(复盘要点)

> 前置 §0.6 ~ §0.11 已经讲过完整脉络。这里只把"取代"这件事的核心矛盾再凝练一次,作为后面 Self-Attention 原理的引子。

| 维度 | RNN / LSTM | Transformer |
|------|-----------|-------------|
| 处理方式 | 按时间步**串行** | 所有 token **同时处理** |
| 长距离依赖 | 信号经多步传递衰减(LSTM 缓解但不根治) | 任意两个 token 直接交互,**距离无关** |
| 计算并行性 | 几乎用不上 GPU 并行 | 完全并行,**训练速度数量级提升** |
| 适合规模 | 千万~亿级参数已经吃力 | 千亿级以上仍可扩展 |

> **生动类比**:RNN 像接力赛传话,一个传一个,后面的人对前面的话越来越模糊。Transformer 像全员开 Zoom,每个人都能直接和任何人对话,信息不衰减。

**关键转折**:Transformer 之所以能做到这两点,核心是它内部的 **Self-Attention 机制**——这就是下一节要讲的。

### 1.2 Self-Attention 在算什么(核心)

**Self-Attention = 让序列中每个 token,加权聚合所有 token 的信息**。

具体怎么算?用前端能懂的视角:

```
输入序列:  ["今天", "天气", "真", "好"]
每个 token 先变成一个向量(高维数组,比如 768 维)
```

对每个 token,生成**三个角色**:
- **Q (Query)**:我在找什么?(类似 SQL 的 WHERE 条件)
- **K (Key)**:我能被什么找到?(类似 SQL 的索引列)
- **V (Value)**:被找到后我提供什么内容?(类似 SQL 的 SELECT 列)

```
"好" 的 Query   →  跟所有其他 token 的 Key 做"相似度匹配"(点积)
                ↓
            得到一组"相似度分数",经过 softmax 变成权重
                ↓
            用这些权重加权所有 token 的 Value,得到"好"的新表示
```

**直观例子**:

```
"好" 的 Q 向量 · "今天" 的 K = 0.1     ← 关系弱
"好" 的 Q 向量 · "天气" 的 K = 0.7     ← 关系强!"好"在修饰"天气"
"好" 的 Q 向量 · "真" 的 K   = 0.2

经过 softmax:[0.10, 0.65, 0.15, 0.10]
                  ↑
             "好" 的新向量 = 0.10·V("今天") + 0.65·V("天气") + ...
             也就是说,"好"现在主要"承载着天气的信息"
```

**结果**:每个 token 的向量都"知道了"它和其他 token 的关系。这就是"上下文理解"在数学上的落地。

### 1.3 Multi-Head Attention:多个角度同时看

一个 Attention 头只能学到**一种关系模式**(比如"修饰关系")。Multi-Head 就是**并行跑 N 个独立的 Attention**(GPT-3 是 96 个头),每个头学不同模式:
- Head 1 学语法依赖
- Head 2 学指代消解(代词 → 名词)
- Head 3 学语义关联
- ...

最后把所有头的结果拼起来。

### 1.4 完整 Transformer Block

一个 Transformer 层 = `Self-Attention + 残差连接 + LayerNorm + FFN(前馈网络) + 残差 + LayerNorm`。GPT-4 据估算有几十~上百层这样的 Block 堆叠。

```
Input ─→ [Attention] ─→ [Add & Norm] ─→ [FFN] ─→ [Add & Norm] ─→ Output
            ↑                              ↑
         token 之间交互                  token 内部加工
```

### 1.5 我们项目里"看不见 Transformer",但需要它

我们调的是 API,Transformer 的内部对我们透明。**但你需要它来回答这些问题**:

| 工程现象 | 用 Transformer 知识解释 |
|---------|----------------------|
| 为什么响应时间和输入长度强相关? | Self-Attention 是 O(n²) 复杂度,n 翻倍计算量四倍 |
| 为什么有 `max_tokens` 上限(比如 128k)? | 受 Attention 内存与训练时上下文长度限制 |
| 为什么"KV Cache"能加速推理? | 已生成的 token 的 K/V 可以缓存复用,无需重算(阶段3 RAG 优化时会遇到) |
| 为什么超长上下文质量会下降? | "Lost in the middle"——长上下文里中段信息权重不足 |

### 1.6 面试速答模板

> "Transformer 用 Self-Attention 替代了 RNN 的循环结构,让序列中任意两个 token 可以直接交互,既解决了长距离依赖、又能并行计算。Self-Attention 的核心是 Q/K/V:每个 token 生成 Query 去匹配所有 token 的 Key 拿到权重,再加权所有 token 的 Value 得到新表示。Multi-Head 是并行跑多个 Attention,学习不同关系模式。
>
> Self-Attention 是 O(n²) 复杂度——这就是为什么超长上下文又贵又慢,也是为什么有 KV Cache、Flash Attention 等优化。"

> **延伸阅读**:八股 07 §1~§3。
> **可视化推荐**:Jay Alammar 的《Illustrated Transformer》(英文,图非常清晰)。

---

## 第二部分:Token 与 Tokenizer

### 2.1 Token 不是字

最容易踩的认知坑:**Token ≠ 字符 ≠ 单词**。Token 是 **subword(亚词单元)**,是 Tokenizer 算法切出来的最小可计费单位。

```
输入文本                Tokenizer 切分结果
─────────────────────────────────────────────────
"hello"                ["hello"]                          1 token
"hello world"          ["hello", " world"]                2 tokens
"unbelievable"         ["un", "believ", "able"]           3 tokens(罕见词被拆)
"你好"                 ["你", "好"]                       2 tokens(中文一字常 1 token)
"哆啦A梦"              ["哆", "啦", "A", "梦"]            4 tokens
"GPT-4"                ["G", "PT", "-", "4"]              4 tokens(罕见组合)
```

### 2.2 Tokenizer 的工作原理:BPE(Byte Pair Encoding)

GPT 系列、Claude、LLaMA 都用 BPE 或其变体。**直观算法**:

1. 把所有字符当作初始 token
2. 统计训练语料中**最常出现的字符对**
3. 把这对合并成一个新 token
4. 重复 2~3,直到达到目标词表大小(GPT-3.5/4 是 ~100k,GPT-2 是 50k)

**结果**:
- 高频词 → **1 个 token**(`the`, `and`, `好`, `今天`)
- 低频词 → **多个 token**(`disestablishmentarianism` 可能拆成 5~7 个)
- 完全没见过的 → **fallback 到字节**(任何 UTF-8 字节都能编码)

> **为什么不直接用单词?**
> 1. 单词总数没上限(新词、人名、缩写)
> 2. 无法处理拼写错误、新造词
> 3. 不同语言切词规则不同(中文连续无空格)
>
> Subword 在词表大小和表达能力之间取折中。

### 2.3 为什么中英文 Token 长度不同

| 文本 | 字符数 | Token 数 | 字符/Token |
|------|--------|---------|----------|
| 英文 `"The weather is nice today"` | 25 | ~5 | 5.0 |
| 中文 `"今天天气真好"` | 6 | ~6 | 1.0 |
| 中文 + 标点 `"今天天气真好,我们出去走走吧。"` | 15 | ~15 | 1.0 |
| 代码 `"function foo() { return 1; }"` | 28 | ~10 | 2.8 |

**规律**:
- **英文**:1 token ≈ 4 字符(一个常见英文单词)
- **中文**:1 token ≈ 1~1.5 字符(汉字密度高)
- **代码**:1 token ≈ 2~3 字符(符号多,识别效率中等)
- **emoji / 罕见字**:1 token 可能 1 个,也可能拆成多个字节

**实战影响**:**同样字数,中文成本约是英文的 2~3 倍**。设计 prompt 时,英文 system prompt 更省 token(但中文 user query 是必须的,无法优化)。

### 2.4 为什么 LLM 按 token 计费

- 计算成本和 token 数线性相关(实际 attention 部分是 n²,但工程上常以 token 数近似)
- Token 是 LLM 内部的"原子单位",对外暴露更精准
- 区分输入(`prompt_tokens`)和输出(`completion_tokens`)单独计费——**输出通常贵 2~5 倍**,因为生成比读取更耗算力

> **GPT-4o-mini 计价示例**(随时变,以 OpenAI 官方为准):
> - Input:$0.15 / 1M tokens
> - Output:$0.60 / 1M tokens(4 倍)
>
> 这就是为什么我们 `config.ts` 把 `MODEL_PRICE_INPUT_PER_1K` 和 `MODEL_PRICE_OUTPUT_PER_1K` 分开。

### 2.5 我们项目里的 token 流程

**完整链路**:

```
用户 query (string)
    ↓
LLM 服务端 Tokenizer 切分 → prompt_tokens
    ↓
模型生成响应 (按 token 流式输出)
    ↓
最后一个 stream chunk 携带 usage:
  { prompt_tokens, completion_tokens, total_tokens }
    ↓
src/agent/llm.ts 中:
  if (chunk.usage) {
    lastUsage = { promptTokens, completionTokens, totalTokens }
  }
    ↓
options.onUsage 回调到 src/index.ts
    ↓
累加 + 按价计算 cost_usd → 日志
    ↓
updateSessionTokens 写入 chat_sessions.total_tokens (持久化)
```

**Fallback 估算**(`src/agent/token-usage.ts:10`):
```typescript
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2)
}
```
为什么是 `/2`?这是**保守上界**——中英文混合场景下取 1 字符 ≈ 0.5 token 的反数。这个估算**只在 API 不返回 usage 时兜底**(部分 MiniMax 兼容协议不实现 `stream_options.include_usage`),实际用 tiktoken 库才精确,但代价是 +30KB 依赖。

**为什么不直接用 tiktoken?**
- Tokenizer 和模型强绑定(GPT-4 和 Claude 用不同 tokenizer)
- MiniMax 的 tokenizer 不开源
- 估算误差 ±20% 在成本统计场景可接受
- 阶段 5 网关层做精细计费时再升级到 tiktoken

### 2.6 面试速答模板

> "Token 是 Tokenizer 用 BPE 算法切出来的亚词单元——高频词一个 token、低频词被拆。这就是为什么 'unbelievable' 是 3 个 token、'你好' 是 2 个 token。
>
> 中英文 token 密度不同:英文约 4 字符/token,中文约 1 字符/token,**同样字数中文贵 2~3 倍**。输入和输出分别计费,输出通常贵 3~5 倍。
>
> 我们项目用 `stream_options.include_usage` 拿模型返回的精确 usage,API 不支持时用 `estimateTokens(text.length / 2)` 兜底。这个误差在成本审计场景可接受,精细化等阶段5 网关层接入 tiktoken。"

---

## 第三部分:推理参数

> 详细原理见 `docs/03-学习笔记/note-01-阶段1-LLM基础三件套.md` 同篇——这里把 `temperature / top_p / max_tokens` 三个最常用的放一起讲。如果想看 temperature 的独立深度解读,可对照之前回答里的内容。

### 3.1 总览:这些参数都在调什么

LLM 每生成一个 token 的过程:

```
1. Transformer 出 logits 向量 (vocab_size 维)
2. softmax(logits / T) → 概率分布
3. 按 top_p / top_k 裁掉低概率长尾
4. 从剩下的候选里抽样一个 token
5. 拼到上下文,回到 1,直到生成 EOS 或达到 max_tokens
   ↑
   每个参数都在动这个流程的某一步
```

| 参数 | 动哪一步 | 形象类比 |
|------|---------|---------|
| `temperature` | 步骤 2:改变分布"形状" | 概率分布的对比度旋钮 |
| `top_p` | 步骤 3:裁采样池 | 只在 Top P% 累积概率里抽 |
| `top_k` | 步骤 3:固定采样池大小 | 只在 Top K 个里抽 |
| `max_tokens` | 步骤 5:何时停止 | 写作硬性字数限制 |
| `presence_penalty` | 步骤 1 的 logits 调整 | 鼓励/抑制已出现的 token |
| `frequency_penalty` | 同上 | 抑制重复出现的 token |
| `stop` | 步骤 5:遇到关键词停 | 自定义 EOS |

### 3.2 temperature(温度)

**做什么**:把 logits 除以 T 再 softmax,**改变概率分布形状**。

```
T → 0   : 分布变尖 → 几乎只选最高概率 token(贪婪)
T = 1   : 模型原生分布(默认)
T → ∞   : 分布变平 → 接近均匀采样(纯随机)
```

**直观图**(同一 logits 的概率分布):

```
T=0.1 → 好████████████████ 99%
        其他:几乎 0

T=1.0 → 好████████   45%
        不错██████   30%
        糟糕███      10%
        热███        8%
        冷██         7%

T=2.0 → 好████       28%
        不错███      22%
        糟糕███      18%
        热███        17%
        冷███        15%
```

**实战取值**(已经在 `.env.example` 注释里):

| 场景 | T |
|------|---|
| 工具调用 / JSON 输出 | 0.0 ~ 0.2 |
| 事实型问答 / RAG | 0.0 ~ 0.3 |
| 一般对话(我们项目) | **0.4** |
| 创意写作 | 0.7 ~ 1.0 |
| > 1.2 | 几乎不用 |

**常见误区**:
- ❌ T=0 = 完全确定 → **错**,浮点 + GPU 并行加法仍有微小随机性,要严格复现需 `seed`
- ❌ T 低 = 准确 → **错**,T 低只是"更自信",模型错了也会很自信地错
- ❌ T 高 = 聪明 → **错**,只是更多样,>1.5 通常退化为胡言乱语

### 3.3 top_p(核采样)

**做什么**:在抽样前,只保留**累积概率达到 P 的那批 token**,长尾全砍掉。

```
原始概率(已排序):
好 0.45 | 不错 0.30 | 糟糕 0.10 | 热 0.08 | 冷 0.07
累积:    0.45 → 0.75 → 0.85 → 0.93 → 1.00

top_p=0.9 → 保留前 4 个(累积 0.93 ≥ 0.9),"冷" 被踢出
top_p=0.5 → 只保留 "好"
```

**温度 vs top_p 的关系**:
- T:改**形状**(柱子高低)
- top_p:改**范围**(留几根柱子)
- **工业实践:T 和 top_p 二选一调,另一个保留默认**——双调容易效果难以预测

我们项目默认 `LLM_TOP_P=1`(不裁),只用 T 控制。

### 3.4 max_tokens

**做什么**:**限制 completion 最多生成多少 token**,达到上限即截断。

**两个作用**:

1. **成本保护**:防止模型陷入循环或冗长输出
   - GPT-4 上下文 128k,真让它写完成本爆炸
2. **延迟保护**:首字延迟低不代表总延迟低,生成 2000 tokens 可能要 30s+

**取值建议**:

| 场景 | max_tokens |
|------|-----------|
| 短回答 / 工具调用 | 256 ~ 512 |
| 一般对话(我们) | **2048** |
| 长文写作 | 4096 ~ 8192 |
| 超长报告 | 8192+(注意成本) |

**陷阱**:
- 截断时不会"漂亮地结束",可能切在句子中间或 JSON 中间
- JSON 输出场景必须配合**结构化输出 / function calling**,而不是靠纯 max_tokens 卡

### 3.5 简短介绍其他参数

- **presence_penalty**(0~2):**已经出现的 token** 的 logits 减去这个值,降低再次出现概率 → 鼓励引入新话题
- **frequency_penalty**(0~2):**出现频率越高,logits 越减** → 抑制重复用词,适合诗歌/创意
- **stop**(string[]):遇到这些子串立即停止生成。常用做法:`stop: ["\n\n"]` 防止 chitchat 输出多段

### 3.6 我们项目里的参数怎么传

`src/agent/llm.ts` 的 `runAgentStream` → `postChatStream`:

```typescript
const stream = postChatStream(
  config,
  {
    model: config.OPENAI_MODEL,
    messages: current,
    tools,
    tool_choice: 'auto',
    // Task 1.1 / 八股 09 §2.4:推理参数全量透传
    temperature: config.LLM_TEMPERATURE,    // 0.4
    top_p: config.LLM_TOP_P,                // 1
    max_tokens: config.LLM_MAX_TOKENS       // 2048
  },
  signal
)
```

三个参数都在 `config.ts` 集中定义,通过环境变量可调整。**面试官如果问"为什么这么选":答案就在 `docs/02-实验记录/exp-01-temperature.md`**(虽然现在还是模板,阶段2 Task 2.3 用评测脚本回填后就是实证)。

### 3.7 面试速答模板

> "Temperature 通过 logits / T 改变 softmax 分布的形状——低温尖锐、高温平坦。top_p 是核采样,只在累积概率达 P 的 top tokens 里抽样,直接砍长尾。max_tokens 是生成上限,既是成本保护也是延迟保护。
>
> 工业惯例是 T 和 top_p 二选一调,我们项目调 T(0.4)、top_p 保持 1。max_tokens 默认 2048,JSON 输出必须配合 function calling 而不是单靠 max_tokens 卡。"

---

## 第四部分:三件套如何在我们项目里串起来

把三个概念串成一次完整请求的"生命周期":

```
┌──────────────────────────────────────────────────────────────┐
│ 用户:"帮我推荐一个适合冬天去的国内目的地"                       │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     ▼ (1) 服务端 src/index.ts
              POST /sessions/:id/stream
                     │
                     ▼ (2) listRecentMessages + system prompt
              messages = [system, ...history, user]
                     │
                     ▼ (3) src/agent/llm.ts postChatStream
              body = { model, messages, temperature, top_p, max_tokens }
                     │
                     ▼ (4) HTTP fetch → LLM 服务端
              ┌──────────────────────────────────────┐
              │ LLM 服务端(我们看不见):              │
              │  ① Tokenizer 切 messages → 输入 tokens│
              │     prompt_tokens 算出来              │
              │  ② Transformer 多层 Self-Attention    │
              │     算出 logits                       │
              │  ③ softmax(logits / temperature)     │
              │  ④ top_p 裁采样池                    │
              │  ⑤ 抽样一个 token,SSE 推回客户端     │
              │  ⑥ 拼上下文,回到 ②                   │
              │     直到 EOS 或达到 max_tokens        │
              └──────────────────────────────────────┘
                     │
                     ▼ (5) SSE 流回到我们
              for await chunk of stream:
                if chunk.usage: lastUsage = ...
                if chunk.choices[0].delta.content: 累积文本
                     │
                     ▼ (6) onUsage 回调
              累加 totalUsage / 算 cost_usd / 落库
                     │
                     ▼ (7) RUN_FINISHED 事件
              全部内容 + usage 返回前端
```

**三件套在这个流程里的位置**:

| 步骤 | 三件套对应 | 我们的代码 |
|------|----------|----------|
| ① 切 token | Tokenizer | LLM 服务端做,我们用 `estimateTokens` 兜底 |
| ② Self-Attention 算 logits | Transformer | 我们看不见,但理解它能讲清楚为什么长上下文慢 |
| ③ softmax + 温度 | temperature | `config.LLM_TEMPERATURE=0.4` |
| ④ 裁采样池 | top_p | `config.LLM_TOP_P=1`(不裁) |
| ⑤ 抽 token + SSE | 流式输出 | `postChatStream` 解析 |
| 终止条件 | max_tokens | `config.LLM_MAX_TOKENS=2048` |
| 计费 | Token | `stream_options.include_usage` |

---

## 第五部分:自测题(进入阶段2 前请确认能答上)

### Transformer / Self-Attention
1. RNN 处理长序列有什么问题,Transformer 怎么解决的?
2. Self-Attention 的 Q/K/V 分别是什么角色?
3. 为什么需要 Multi-Head Attention?
4. Self-Attention 的时间复杂度是 O(?),这对工程有什么影响?
5. 为什么超长上下文会出现"Lost in the middle"?

### Token / Tokenizer
6. Token、字符、单词三者的关系?
7. BPE 算法的核心思想?
8. 为什么中文比英文 token 更密?
9. 为什么输出 token 比输入贵?
10. 我们项目的 `estimateTokens` 为什么用 `length / 2`,什么时候应该升级为 tiktoken?

### 推理参数
11. T=0 等于完全确定吗?为什么?
12. T 和 top_p 哪个改"形状"、哪个改"范围"?
13. 工业上为什么 T 和 top_p 二选一调?
14. max_tokens 的两个作用?为什么 JSON 输出不能只靠 max_tokens 限制?
15. 旅游 Agent 场景为什么 T 选 0.4 而不是 0.0 或 0.7?

> **建议**:挑 3 道写在纸上的自己的话回答,然后翻 `docs/01-面试八股文/07-大模型基础.md` 对照修正。这就是"输出倒逼输入"的学习闭环。

---

## 第六部分:进入阶段2 前的准备

阶段2 是 **Prompt Engineering**,核心是"用结构化的提示词把 LLM 的能力用出来"。本笔记的三件套是阶段2 的**前置概念**:

| 阶段2 任务 | 用到的三件套知识 |
|----------|----------------|
| Task 2.1 提示词版本化 | Tokenizer:不同 prompt 模板的 token 成本 |
| Task 2.2 Few-shot / CoT | Transformer 上下文窗口:示例 + CoT 会显著增加 prompt_tokens |
| Task 2.3 评测框架 | 推理参数:同 prompt 不同 T/top_p 对结果的影响 |

**带着这些问题进阶段2**,会比"边做边查"高效得多。

---

## 第七部分:延伸阅读路线

如果想再深入,按这个顺序:

1. **入门可视化**:Jay Alammar 《Illustrated Transformer》、《Illustrated GPT-2》
2. **八股系统化**:`docs/01-面试八股文/07-大模型基础.md` 通读一遍
3. **官方原始**:Vaswani et al. 2017 《Attention is All You Need》(论文,不长,英文 8 页)
4. **工程实战**:OpenAI Tokenizer Playground(`platform.openai.com/tokenizer`),亲手输入中英文混合看 token 切分
5. **进阶**:Flash Attention 论文、KV Cache 优化、Grouped Query Attention(MHA → GQA)

---

## 收束

学完这篇,你应该能:

- ✅ 用自己的话讲清楚 Transformer/Self-Attention,知道为什么取代了 RNN
- ✅ 知道 token 不是字、中英文密度不同、输入输出分别计费
- ✅ 知道 temperature/top_p/max_tokens 各自动什么,我们项目为什么这么取值
- ✅ 能把这三件套和已经写出来的代码对应上(`postChatStream` 那几行参数透传,你应该秒懂)
- ✅ 看 `docs/01-面试八股文/07-大模型基础.md` 不再吃力——本笔记是它的"工程化解读版"

**你现在已经具备了进入阶段2 的全部前置知识**。

---

## 附录:本笔记涉及的代码位置速查

| 概念 | 代码位置 |
|------|---------|
| 流式 SSE 解析 | `src/agent/llm.ts:postChatStream` |
| 推理参数透传 | `src/agent/llm.ts:runAgentStream` 中 `temperature/top_p/max_tokens` |
| 参数配置 | `src/config.ts` 的 envSchema |
| Token 估算 fallback | `src/agent/token-usage.ts:estimateTokens` |
| usage 累加 | `src/index.ts` 的 `onUsage` 回调 |
| 成本计算 | `src/index.ts` 的 `cost_usd` 日志字段 |
| 持久化 | `src/db/chatRepo.ts:updateSessionTokens` |
