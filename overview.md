# 音帧 SonicFrame · AI 音乐视频生成器 — 任务总览

## 完成了什么

一个**零依赖、纯前端、可直接双击打开**的 MV 生成网站（原型级但全流程可用）：

- **三步流程**：① 添加歌曲 → ② 添加歌词 → ③ 画面风格，顶栏有进度指示，配使用指南弹窗
- **自动读取**：歌名/歌手/内嵌封面/**内嵌歌词**（MP3/WAV/M4A/FLAC 全格式，含 GBK 兼容）；读不到时自动从文件名推断，且可手动修改
- **歌词引擎**：支持 .lrc 精确同步；纯文本歌词按“自然朗读时长 + 行间停顿”智能铺满全曲；长句按标点自动断行；支持整体时间微调 ±3s
- **段落标记过滤**：自动剔除 [Verse 1]、[Chorus] 等编曲标记；相邻重复句（AI 歌词常见“同一句连写两遍”）自动合并
- **AI 背景图（真·文生图）**：pollinations.ai 免费服务自动绘制，中文歌词→英文场景提示词，裁掉底部水印；每 45 秒限 1 张，站内排队；失败保留旧图或纯色兜底
- **MV 画面**：片头歌名卡、逐字卡拉 OK 滚动歌词（唱完后长间奏有轻呼吸动效，画面不死板）、律动柱、推镜、进度条、角标（均可开关）
- **规格**：16:9 / 9:16 / 1:1 / 4:5 四种比例，1080p / 720p / 540p 输出，可导出单帧 PNG 封面
- **体积控制**：默认目标 ≤10MB，按歌曲时长反推码率，自动降清晰度；导出前显示预计大小
- **导出（R9 重写）**：**离线逐帧编码**——WebCodecs H.264(CBR)+AAC，自研 MP4 封装器（零依赖）。逐帧渲染时间戳精确，**画面绝不会卡住/冻结**，切窗口无影响；旧版 MediaRecorder 实时录制保留为兼容兜底
- **隐私**：全部在浏览器本地完成，文件不上传

## R9：修复“视频中间文字卡住不动”

- **根因（实测取证）**：旧导出走 MediaRecorder 实时录制，靠画布“每帧变化”产帧。解析用户成片发现：47.7s→127.1s 只有 **1 帧**（79.4 秒冻结），视频轨在 157s 就断流而音轨有 213s——页面切后台/主线程卡顿时画面停更、声音照走。
- **修复**：新增 `assets/sfexport.js`（离线逐帧编码：FFT 频谱预计算 + VideoEncoder + AudioEncoder）与 `assets/mp4mux.js`（渐进式 MP4 封装：avc1+AAC、moov 前置、单 chunk）；`app.js` 导出入口自动优先离线通道，失败回退实时录制。
- **踩过的坑**：AAC 编码器不接受 64k 码率（硬性门槛，配置直接 unsupported）→ 音频固定 96k；硬件编码器声道限制 → 按 2ch→1ch 依次探测；VBR 码率失控（9:16 超目标 35%）→ 优先 CBR（bitrateMode:'constant'），实测码率误差 <5%。
- **实测**（《算了吧》3:34）：16:9→960×540/8.82MB/108s；9:16→720×1280/8.81MB/130s；帧表 5137 帧全部 41.7ms、**0 段冻结**、24.00fps；抽帧核对了 22s/80s/92s 歌词与 LRC 同步一致。

## R10：1080p 也能压进 10MB（AV1 编码通道）

- **结论**：可行，但 H.264 做不到——10MB 预算下全曲 1080p 只有约 216kbps，H.264 会明显糊块。实测本机 Chrome 的 H.264/HEVC/AV1 均可用，**AV1 在 216kbps 下 PSNR 31~34dB、观感良好**（MV 画面多为静态背景，压缩效率远超通用估算）。
- **实现**：`sfexport.js` 新增 `pickAv1()`（av01.0.08M.08 + CBR）与 `buildAv1C()`——Chrome 的 AV1 编码器 output 里 `decoderConfig.description` 为 **null**（实测），须自己解析 OBU、提取 Sequence Header 按 ISOBMFF 规范拼 av1C；`mp4mux.js` 支持 av01 样本条目；`app.js` 选 1080p+≤10MB 且 bpp 不达标时若支持 AV1 则保 1080p（码率按 1.22 倍预留超标余量，实测超标 ~17%），不支持则维持降档；AV1 中途失败自动回退 H.264 重导。
- **实测**（《算了吧》3:34）：16:9→**1920×1080 / 7.90MB / 198s**；9:16→**1080×1920 / 7.64MB / 192s**；帧表均 5137 帧全部 41.7ms、0 段冻结、108 关键帧。
- **兼容性**：AV1-in-MP4 需较新播放器（Chrome/Edge/近年手机）；老设备播放异常时改选 720p 或放宽体积（自动回 H.264）。

## R11：AI 场景三分类（风景 / 人物 / 城市风景）

- **需求**：AI 背景主要生成三类场景——风景、人物、城市风景。
- **实现**：
  - `scene.js` 重写 AI 提示词系统：三类各有 8 款英文场景模板 + 关键词词典；`detectAiType()` 按歌词自动归类（城市词加权 1.3，无命中默认风景），seed 决定同类里取哪一款（同内容稳定、重新生成换款）；人物类统一**背影/剪影**（AI 正脸易画崩，背影更有 MV 故事感）；时间/氛围修饰词继续从歌词提取
  - `index.html` 场景面板新增「场景类型：自动/风景/人物/城市」按钮；`app.js` 切换类型即按新类型重生成，缓存键加入类型（类型|比例|种子）
- **顺手修掉的三个隐患**：
  1. `Scene.AI_COOLDOWN_MS` 因导出顺序提前拿到 **undefined**——45 秒排队从未生效过（导出移到文件末尾修复）
  2. TIME_MAP/MOOD_MAP 正则带 `/g` 标志，`test()` 有状态导致同 seed 提示词**不稳定**（去 g 修复）
  3. pollinations 限流时返回 HTTP 402 + **"Free limit reached" 占位图**，`<img>` 会把它当正常背景收下（实测截图抓到）→ 改 `fetch` 检查状态码，402 按失败处理并提示排队
- **实测**：归类 4/4 正确；三类提示词符合预期；同 seed 稳定、换 seed 换款；UI 联动 + 402 友好降级均验证通过。

## R12：格式扩展 + 内嵌歌词 + 产品化补齐（2026-10-24）

- **音频格式**：支持 MP3 / WAV / M4A / FLAC / OGG / AAC / OPUS（accept 与解码校验扩展；Chrome decodeAudioData 原生覆盖）
- **内嵌歌词自动识别**：`id3.js` 重写为全格式标签解析器——ID3v2 USLT（无时间戳）与 SYLT（带时间戳→转 LRC）、
  FLAC VORBIS_COMMENT（LYRICS/UNSYNCEDLYRICS）+ PICTURE 块、M4A ilst（©lyr/©nam/©ART/©alb/covr）、
  WAV RIFF 'id3 ' 块。载入歌曲后歌词框为空则自动填入，用户已填内容不覆盖
- **AI 提示词增强**：画质尾缀升级为“专辑封面级（album cover art quality / professional music photography / dramatic color grading）”；
  新增曲风引导 STYLE_MAP（古风水墨/嘻哈/电音/民谣胶片/摇滚现场，按歌词命中注入）
- **产品化补齐**：
  - 9:16 平台安全区：歌词收窄至 76% 宽、律动柱上移至 72%、品牌角标挪到右上角
  - 歌词断行 ≤14 字（MAX_CHARS 16→14）+ 渲染端最小字号下限（≥0.024×画布宽）
  - 「封面取色」主题：48×48 缩样 + 12 色相桶加权提主色 → 强调色/副色归一到可读区间，黑白灰封面自动拒绝
  - 响度标准化：解码后按 RMS 估算 LUFS 统一到 -14（±12dB 限幅 + 0.98 削波保护），预览与导出同一链路
  - 模板扩到 10 套配色（新增深海蓝/薄荷/鎏金/极简白）
  - 合规：导出前强制勾选权利声明（未勾选阻断导出，勾选状态记忆）、页脚隐私说明与投诉入口
  - 草稿自动保存（localStorage）：歌词+全部设置，刷新自动恢复（音频文件需重选）
- **实测**（.tmp/p10.js 无头端到端）：WAV+RIFF id3 歌词自动填入/LRC 模式/3 行解析 ✓、
  响度 -29.7→+12dB 归一 ✓、未勾选导出被阻断 ✓、草稿刷新恢复 ✓、竖屏安全区截图 ✓、
  FLAC 构造解析 ✓、提示词画质/曲风引导 ✓；30 秒离线导出回归（AV1 1080p 720 帧 45.8s）✓
- **文档**：docs/product-review.md 全文标注 ✅/🏗️ 状态；ASR 打轴与云端渲染的架构与成本写入对应章节

## R13：歌词自动识别修复 + 联网歌词库 + AI 背景提亮（2026-10-24 下午）

用户反馈两项没生效，排查结论：

- **歌词识别没生效的真相**：① 解析器本身正常（用户 MP3 实测提取 477 字歌词），
  但"框非空才填入"的旧逻辑 + 草稿自动恢复，导致内嵌歌词永远被旧内容挡住；
  ② 用户新换的 M4A **文件本身没有任何元数据**（无 ilst/无标题/无歌词），内嵌路线天然无解。
- **修复**：内嵌歌词改为**换歌即整体覆盖**（文件指纹 name|size 判断同文件重复导入才保留）；
  新增 **lrclib.net 联网歌词匹配**（免费、CORS、无需密钥）——载入歌曲后有歌名就自动搜，
  按 |时长差| 打分挑最接近的同名曲（重名歌防错配），syncedLyrics 优先；面板加「联网找歌词」按钮；
  用户手输歌词标 manual 不会被自动覆盖；换新歌无歌词时清掉上一首残留。
- **AI 背景暗淡的真相**：模板词库大量 night/after rain/dusk + 旧尾缀 dramatic color grading。
  **修复**：尾缀改 vivid saturated colors / bright cinematic lighting / well-lit；
  24 款模板全部改成明快版（sunlit/golden hour/glowing）；夜景等暗模板出图后实测平均亮度
  <72/255 时自动提亮至 ~100 + 饱和 1.18（像素级兜底，与提示词双保险）。
- **实测**（.tmp/lyr13.js 无头端到端）：内嵌歌词覆盖旧内容 ✓；联网匹配《算了吧》4~6s
  返回 28 行带时间轴 LRC ✓；M4A（无元数据）载入正常、乱串歌名安静失败 ✓；
  最暗夜景提示词出图平均亮度 97/255 ✓。

## R14：商业头部 + 删除专业建议 + 中英双语（2026-10-24 下午）

- **商业 Header**：品牌区（SonicFrame + AI Music Video Studio 副标）、导航栏
  （Song/Lyrics/Style/Export/FAQ 锚点跳转，FAQ 打开指南弹窗）、进度指示保留、
  语言切换按钮 + Guide + Export MV；<1180px 隐藏导航与进度。
- **删除「专业建议」**：index.html 按钮+notesDialog 整块、app.js 绑定与 els 引用。
- **双语 i18n（默认英文）**：新增 assets/i18n.js——85 处 data-i18n 静态标记
  （中文为源，EN 词典映射）、data-i18n-ph 占位符、title/lang 切换、
  动态文案 tr()（toast 按 ' · ' 分段 + 正则规则 + 《》→引号）、
  主题名/场景名/画布空闲演示文案/品牌角标全部跟随语言；
  localStorage 记忆，切换后 __sfLangRefresh 重写状态类文案。
- **部署**：github.com/moonhawk2022/sonicframe（GCM OAuth 授权），
  GitHub Pages 已上线：https://moonhawk2022.github.io/sonicframe/
- **实测**（本地 + 线上双跑 .tmp/hdr14*.js）：默认 EN 全部生效、切中文即时生效且持久化、
  专业建议已移除、FAQ/Guide 弹窗正常、demo toast 英文、0 JS 报错。

## 文件结构

```
index.html            页面（含使用指南、专业建议弹窗）
assets/styles.css     样式
assets/id3.js         全格式标签解析（ID3 USLT/SYLT / FLAC / M4A / WAV，歌词+封面）
assets/lyrics.js      LRC 解析 + 智能对齐 + 标记过滤 + 重复句合并
assets/scene.js       AI 背景生成器
assets/renderer.js    Canvas 渲染引擎（支持固定步长 dt，离线导出可复现）
assets/mp4mux.js      自研 MP4 封装器（H.264/AV1 + AAC）
assets/sfexport.js    离线逐帧导出（FFT 频谱 + WebCodecs 编码，支持 AV1 小体积模式）
assets/app.js         音频引擎、播放控制、码率规划、导出调度、UI 逻辑
docs/product-review.md  产品评审：8 大类缺口 + 架构演进路线
```

## 已知限制

- 离线导出耗时≈歌曲长度的 50%~100%（取决于机器与硬件编码器），无硬件编码器时较慢；老浏览器无 WebCodecs 时自动回退实时录制（该模式仍需保持前台）
- AI 文生图依赖 pollinations.ai 免费服务（每 IP 每 45 秒限 1 张），正式产品建议接通义万相/Kolors
- AAC 无 edit list（约 40ms 编码器延迟），听感无影响

## 建议下一步

1. 打开 `index.html`（Ctrl+F5 强刷）重新导出一次，验证新成片
2. 阅读 `docs/product-review.md` 决定第一版上线范围


## R15（2026-10-25）：音频转 MP3 工具
- 导航新增"工具"，打开转换弹窗（convDialog）
- assets/convert.js：AudioContext 解码任意音频（m4a/wav/flac/ogg）→ 非 lame 支持采样率自动重采样 44100 → Int16 PCM → lamejs 分块编码，进度条分两段（解码 20% + 编码 80%）
- assets/lame.min.js（1.2.1）本地引入；调用方式 new lamejs.Mp3Encoder(ch, sr, kbps)
- 码率可选 128/192/320，产物命名"原名.mp3"，全本地不上传
- 双语：EN 词典新增 navTools + cv* 键，动态提示走 SFI18N.lang 判断
- E2E 验证：真实 WAV→MP3（fffbb4 帧头合法）、0 JS 报错、中英切换正常
- R15b（用户复述需求）：由弹窗改为页面独立分区 #step-convert（与歌曲/歌词/画面并列），导航"转换 MP3"锚点直达，转换完成直接显示"下载 MP3"按钮
- 坑：lame.min.js 全局是函数 lamejs（实例上无 Mp3Encoder，需静态调用）

## R15c（2026-10-25）：修复转换后 MP3 失真
- 根因：交错 PCM（L,R,L,R…）被按前后对半硬拆喂给 lamejs，左右声道互相串音 → 听不清
- 修复：先解包为每声道独立 Int16Array，再 encodeBuffer(L, R)；进度/循环改按"每声道样本数"推进
- 回归验证：L=440Hz/R=880Hz 测试音转换→解码→DFT：L440=0.2425、R880=0.2425、串频≈0.0001（声道正确、幅度无损）


## R16（2026-10-25）：歌曲风格分析 → AI 音乐提示词
- 新分区 #step-analyze（导航"仿写提示词"/Style Prompt），assets/analyze.js
- 特征提取（纯前端 Web Audio + 自写 FFT）：
  · BPM：能量包络自相关（60–180 搜索窗，折叠 70–180）
  · 调性：4096 点 FFT 色度图 × Krumhansl 大/小调轮廓相关（关系大小调等价为正常现象）
  · 音色：频谱质心；低/中/高频占比；人声感 300–3500Hz 占比；动态范围（10/90 分位包络）
- 特征映射为风格描述（tempo/timbre/bass/vocal/dynamics/mood/genre 猜测）
- 生成 Suno 风格英文提示词（Genre/Tempo/Key/Mood/Sound/Vocals/Dynamics/Production），一键复制
- 验证：合成 120BPM+C 大调测试音，Node 与无头浏览器双端 BPM=120 精确命中、调性识别正确（关系调等价）、特征卡与提示词正常生成，0 JS 报错
