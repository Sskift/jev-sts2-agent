# Agent Loop 技术选型与资源预算

更新：2026-09-20。本文记录本机依据、选型理由和验证边界；已按用户新授权采用 STS2-Cli-Mod 并完成首场真实战斗。详细记录见 [2026-09-20 验证](validation-2026-09-20.md)。

**采用 Node.js 编排 + 游戏内 C# mod：结构化 state → Jev 完整动作选择 → Named Pipe → 游戏动作 → 重读 state。** 默认 `npm start` 可完全不截图，不调用 Opus、不启动或编译额外窗口驱动；游戏动作本身照常渲染动画。Opus 5、常驻 C# Windows 驱动及 `PrintWindow + PostMessage` 仅在需要处理未覆盖界面或可选留证时使用，也可通过模组扩展消除具体 UI 缺口。游戏使用普通非置顶窗口；模组的 `ping/state/new_run` 已在最小化状态成功，完整战斗是在非最小化、非前台窗口中完成，窗口截图驱动仍拒绝最小化。

本机已安装上游 `0.102.1` 并部署 `0.111.0-local-compat`。主客户端直接连接 `\\.\pipe\sts2-cli-mod`，避免为每一步启动独立 `sts2.exe`。服务器每条连接处理一行 JSON 后关闭，因此客户端串行短连接，不把它与可选窗口驱动的常驻 JSON-lines 子进程混为一谈。[上游 PipeServer](https://github.com/longkerdandy/STS2-Cli-Mod/blob/main/STS2.Cli.Mod/Server/PipeServer.cs)

## 1. 判断负载的方法

本项目不把“Python 天生很重”当成技术结论。Python 也提供异步 I/O 和直接调用原生库的能力；调用同一个 Windows 截图 API 时，成本还取决于复制的像素、编码器、数据往返、进程生命周期和采样频率。缺少同工作量测试，不能断言改成 C# 或 Rust 就一定降低整机占用。[Python asyncio](https://docs.python.org/3/library/asyncio.html)、[Python ctypes](https://docs.python.org/3/library/ctypes.html)

这里不继续依赖 Python，是因为 Node 编排已存在，Windows 驱动能直接用本机 .NET SDK 实现，维持两种运行时足以完成任务，减少一套解释器、Pillow 和每步启动脚本的维护成本。C# 也有运行时和 GC，Node 也有 V8；二者都不是“零开销”。

优先控制实际工作量：一个编排进程，mod 复用游戏现有运行时，只有开启截图/CU 时才启动一个复用的窗口驱动；每次决策只执行一步，先读结构化 state，按需截图。等待模型响应或游戏动画时让线程休眠。不得为了等待下一步持续捕获并压缩 60 FPS 画面，也不在 JavaScript 中逐像素处理大图。Node 官方同样强调避免阻塞事件循环和把过大的计算放在单个回调内。[Node 事件循环与阻塞说明](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop)

## 2. 各组件使用什么

| 组件 | 当前选择 | 适合当前任务的原因 | 成本与替换条件 |
|---|---|---|---|
| 闭环、模型 HTTP、候选动作、运行证据 | Node.js，现有 `.mjs` | 工作主要是网络等待和小型 JSON；复用现有 Opus/Jev、超时、测试和日志代码 | 大图编码和高频计算不要堆到事件循环；只有测得编排本身成为瓶颈才重写 |
| 主状态与动作通道 | 游戏内 STS2-Cli-Mod，C# / .NET 9 runtime | 直接读取合法性、牌 ID、目标 combat_id，调用游戏动作；不依赖前台光标 | 与游戏 API 版本绑定；必须保留本地兼容补丁和动作后验证，不能假定所有 modal 都被覆盖 |
| HWND 定位、DPI、client 坐标、输入 | C# / .NET 8，P/Invoke | Windows API 边界明确；本机 SDK 已可用；错误、JSON、资源释放容易与现有工程集成 | 有 CLR 基础内存和 JIT；使用常驻进程摊销，后续依据测量决定是否进一步压缩 |
| 证据与后备截图 | C# `PrintWindow` + PNG | 依赖少，已在本机 D3D12 非前台窗口与终局遮挡状态验证 | 同步调用可能阻塞，其他 GPU/渲染器可能返回空白或旧帧；须检验真实图像与状态变化 |
| 遮挡截图后备 | WGC，仍放在独立驱动中 | 按 HWND 选择窗口，使用 GPU frame pool；适合把捕获与桌面遮挡分离 | WinRT/COM、D3D11 frame pool、resize/device-lost 管理更复杂；按需复制和编码，不积压帧 |
| 未覆盖弹窗输入 | `PostMessage`，client 像素坐标 | 不必移动系统光标；已经处理模组未识别的教程弹窗 | 投递成功不等于游戏接受；该单次点击不证明拖拽或所有弹窗可用 |
| 输入后备 | 短暂聚焦后执行；事后恢复可恢复的桌面状态 | 用户已允许必要时短暂占用焦点，能覆盖只接收前台输入的界面 | 必须记录实际使用次数和占用时间；不把游戏设为永久置顶；不能把每次抢前台冒充后台输入成功 |

上游出牌处理器校验实际游戏规则后加入 `PlayCardAction`，本项目不修改牌费、敌方 HP 或伤害来制造验收。主状态允许使用用户授权的结构化接口，无需模拟鼠标。当前候选只用所需状态字段，默认不展开牌堆详情。[PlayCardHandler](https://github.com/longkerdandy/STS2-Cli-Mod/blob/main/STS2.Cli.Mod/Actions/PlayCardHandler.cs)

P/Invoke 是 .NET 官方支持的原生互操作路径，可调用 unmanaged 函数、结构体和回调。这里的选择是工程适配判断，不是声称 C# 比其他语言普遍更快。[.NET P/Invoke](https://learn.microsoft.com/en-us/dotnet/standard/native-interop/pinvoke)

### Rust / C++ 为什么保留，而非立即全部重写

| 方案 | 优点 | 本项目需要付出的代价 | 采用时机 |
|---|---|---|---|
| Rust 原生 helper | 不依赖 GC；所有权有利于管理缓冲区；微软维护 Windows API 的 Rust bindings | 增加 Cargo/toolchain、FFI 与 WinRT 适配面；不自动解决窗口黑帧、游戏忽略消息或 GPU readback 成本 | 测得 C# helper 常驻内存或 GC 是明确问题，或需要发布更小的长期运行组件 |
| C++ / WinRT helper | 直接对接 Win32、COM、D3D11/WGC；原生资源和 GPU 路径控制充分 | 需要严格处理 COM/句柄/缓冲区生命周期；新增构建和跨语言调试成本 | WGC 的 C# 互操作形成具体障碍，或需要持续高频 GPU 图像管线 |
| C# Native AOT | 可以减少启动与运行时部署负担，不必立刻换语言 | 需审查 trimming、反射、COM、图形依赖的兼容性；当前 `UseWindowsForms` 项目不能假定直接勾选即可发布 | 测量证明值得优化，且针对实际依赖做构建与运行验证后 |

以上是选择条件，没有进行三种 helper 的同条件性能赛跑。Rust 的无 GC 和 Windows bindings 有官方依据；C++/WinRT 是微软的标准 C++ WinRT 投影；Native AOT 的限制应以目标 .NET 版本实际文档和构建结果为准。[Rust 官方介绍](https://rust-lang.org/)、[微软 windows-rs](https://github.com/microsoft/windows-rs)、[C++/WinRT](https://learn.microsoft.com/en-us/windows/apps/develop/cpp-winrt/intro-to-using-cpp-with-winrt)、[Native AOT](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)

## 3. 截图后备：正确性先于 API 返回值

当前 `native/WindowDriver/Program.cs` 对目标窗口调用 `PrintWindow`，按 client 尺寸保存 PNG，并用采样颜色检查明显空白。`PrintWindow` 是同步调用，目标应用参与渲染，因此放在独立 helper 中，主编排设超时。微软 API 文档公开 `PW_CLIENTONLY`；当前代码另外使用的 `0x2` 完整内容选项，应视作需要本机验证的兼容做法，不能据此保证所有 GPU 窗口都可捕获。[PrintWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow)

非黑帧只是一道初筛：错误窗口、旧画面、标题栏或有颜色的空表面也能通过。验收需保留同一 HWND 的截图及 client 尺寸，目视确认画面；让场景在后台实际发生变化，再确认新帧出现对应变化。游戏被普通窗口覆盖后，截图仍应是游戏内容，而非遮挡窗口。

若失败，采用 WGC 的 `IGraphicsCaptureItemInterop.CreateForWindow(HWND)`。该入口最低要求 Windows 10 1903，本机 Windows 11 build 26200 满足版本门槛；实际仍检查设备支持。WGC 用有限 frame pool，及时释放帧，resize 后重建并裁到 `ContentSize`，避免把未定义区域当游戏像素。捕获源是游戏窗口不意味着游戏最小化后必然继续渲染，也不构成所有显卡/渲染后端的可用性保证。[WGC HWND 入口](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow)、[WGC 帧生命周期](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)

桌面截图再裁切不能满足被遮挡窗口验收，故不作为该能力的最终实现。裁剪或缩放时必须显式记录变换并逆变换坐标；现在驱动和视觉都使用 client 原始像素，并在动作前确认窗口身份和尺寸未改变。

## 4. 动作通道与 CU 后备

主动作通过 mod 请求执行，Jev 返回后重读 state 核对动作相关字段，避免并发用户操作或动画让选择过时。动作响应之后再读状态，确认手牌、能量、敌人或场景变化。三次动作均无变化停止排查，传输超时不自动重放；教程弹窗已经证明 mod 的结构化 `screen` 也可能漏掉覆盖层。

本地兼容构建替换了三个 `IsPlayPhase` 和五个 `Inventory` 旧 API 引用，用玩家 `Phase == PlayerTurnPhase.Play` 与 `GetLocalInventory()`，结束回合补充等待 `PlayerTurnPhaseChanged`。使用本机 SDK 8 Roslyn 与游戏自带 .NET 9 实现程序集，不需全局安装 SDK 9。精确补丁和构建记录在 `temp/compat-build/`；部署文件为游戏 `mods/STS2.Cli.Mod.dll/json`，备份在 `temp/mod-install-backup/settings.before-cli.save` 和 `STS2.Cli.Mod.release.dll`。只读元数据和成功编译曾用于确认 API，现已进一步用一场战斗验证出牌与回合，商店仍未验证。

`PostMessage` 只把消息投递到窗口线程队列，返回时目标线程可能还没处理；它还受进程完整性级别的 UIPI 约束。无需为普通权限游戏无条件提权。成功返回后，应等待动画并重新截图，用牌离手、能量/敌方生命变化或场景推进证明动作生效；超时后执行状态未知，先观察再决定，不能盲目重发。[PostMessage](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-postmessagew)

Godot 4.5 官方 Windows 源码给出了能尝试后台消息的依据：普通 `WM_MOUSEMOVE` 及按钮事件取 `lParam` 坐标并传入输入系统。但 hover 窗口用真实 `GetCursorPos` 判断，button mask 使用 `GetKeyState`；因此后台 click、hover、drag、keyboard 必须分别验证。按钮 down 还会调用 `SetCapture`。本机是定制 MegaDot，官方上游源码只是诊断线索，不能代替实测。[Godot 4.5 Windows 输入源码](https://github.com/godotengine/godot/blob/4.5-stable/platform/windows/display_server_windows.cpp#L5057)

最新用户约束允许必要时短暂聚焦，策略应表现为可观测的两种执行模式：优先 `background`；在具体界面确认后台方式无效后才进入 `focus-fallback`。每次记录 HWND、输入方式、前后 foreground/cursor、是否恢复、聚焦耗时及截图结果。若用户期间主动切换窗口或移动光标，不机械地把其操作复位。`SetForegroundWindow` 受 Windows 限制，调用可能被拒绝；必须确认实际 foreground 后再发送依赖前台的输入，拒绝时记录失败，不在错误窗口继续输入。[SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)

“非顶层运行”在这里指无 `always-on-top`，游戏不需要持续占据前台，遮挡时仍能继续渲染和闭环观察。短暂聚焦时可能暂时改变 z-order，这是已允许的后备行为，需要如实统计。持续要求用户把游戏放在最上面不满足目标；仅配置 `SW_SHOWNOACTIVATE` 或检测到游戏进程存在也不证明满足目标。

若以后扩展模组处理 UI 输入，可考虑游戏主线程 `Input.ParseInputEvent`；Godot 文档明确该 API 本身不移动操作系统鼠标，也不执行 OS 窗口切换。它目前不是已实现能力，不再作为主战斗通道的前置要求。本机 `sts2.xml` 描述控制器模式切换会 warp 光标，因此不把模拟手柄当成无干扰输入的捷径。[Godot Input](https://docs.godotengine.org/en/4.5/classes/class_input.html#class-input-method-parse-input-event)

## 5. 本机实证与缺口

2026-09-20 依据本机只读配置、源代码以及主任务保存的真实运行状态和截图核对。没有为了编写本文额外操控游戏或运行压力测试。

| 项目 | 已知证据 | 能证明什么 / 不能证明什么 |
|---|---|---|
| 操作系统 | CIM：Windows 11 家庭版，`10.0.26200` | 满足 WGC 版本门槛；不代表已经实测 WGC |
| CPU / 内存 | CIM：i7-12650H，10 核/16 逻辑处理器，系统报告物理内存约 23.71 GiB | 是本机配置；没有据此推算可用算力或空闲内存 |
| GPU | CIM：RTX 4060 Laptop GPU + Intel UHD；现有游戏日志用 RTX 4060、D3D12 | 是已记录渲染设备；没有测得 GPU 占用、功耗或显存余量 |
| 编排 / 驱动工具链 | 实际命令：Node `v25.8.1`，.NET SDK `8.0.408`；驱动目标 `net8.0-windows` | 工具链可用；游戏自带的 .NET 9 runtime 是另一运行环境 |
| 游戏版本 | 安装目录 `release_info.json`：`v0.111.0`；日志：`MegaDot v4.5.1.m.14.mono.custom_build` | 固定本次兼容性基线；不推及其他更新版本 |
| 实际窗口 | 首场战斗 client 1280×720；终局 `topmost:false`、多个更高层窗口重叠 | 终局截图有效；不等于持续采样了每个瞬间的 z-order，最新计数见验证记录 |
| Mod 状态 | 当前 `mods_enabled:true`，仅 STS2.Cli.Mod 启用，RebalancedRegentForging 单独禁用 | 启用前 false 配置已备份；没有顺带启用修改玩法的模组 |
| Opus 5 | `temp/opus-smoke-result.json`：320×240 合成图、HTTP 200、`claude-opus-5`、3709 ms、中心误差 2 px | 合成图 API 路径成功；不是游戏牌面准确率或平均延迟 |
| Jev | `docs/validation-2026-09-19.md`：三 primitive 请求返回 `jev-1.13.0`，675 ms | 记录的一次 API 请求；不是完整战斗策略或吞吐基准 |
| 战斗中的 Jev | 11 次实际 `jev-1.13.0` 请求；约 281–1584 ms/次；合计 25010 输入、645 输出 tokens | 是本次样本，不是长期平均延迟或费用预测 |
| 常驻驱动与控制协议 | `src/window_driver.mjs` + `native/WindowDriver/Program.cs`：JSON-lines、多请求 ID、同一 child、空白检查、超时不重发、client 尺寸核对 | 代码已存在；mock 协议测试不能证明游戏接收后台动作 |
| 聚焦后备 / WGC | 本文检查的驱动快照尚无相应实现 | 是明确的实现路线，不能写成已交付能力 |
| 教程盲区 | `temp/mod-tutorial.png` / `mod-after-tutorial.png` / `mod-tutorial-dismiss.json` | 后台点击处理一个未覆盖弹窗并进入地图；不证明所有 UI 覆盖 |
| 单场验收 | `run-artifacts/2026-09-19T16-39-33-428Z-dcc28eb7/`：17 轮、11 命令、6 出牌、2 结束回合、40.4 秒到 `REWARD`；画面 68/80 HP、20 金币和卡牌奖励 | 已核对同场活敌、动作响应/变化、终局状态与截图；本次无需 Opus/CU 战斗输入，不代表通关或商店实测 |
| 后台记录 | 28 份窗口/捕获样本为游戏非前台且 foreground/cursor 不变 | 支持本次后台运行结论；不是连续的系统焦点追踪或所有硬件保证 |
| 性能基准 | 尚未测量同负载 CPU/GPU/内存差值 | 不从语言名称、硬件型号或 40.4 秒单次总耗时推算资源占用 |

历史日志与保存配置的位置分别是 `%APPDATA%/SlayTheSpire2/logs/godot.log` 和 `%APPDATA%/SlayTheSpire2/steam/<account>/settings.save`。本机安装目录为 `D:/SteamLibrary/steamapps/common/Slay the Spire 2`。账号标识和凭据不需要进入仓库。

## 6. 性能实施顺序与验收记录

模组通道无需每步传图，减少截图、编码和视觉 API 调用是本次最直接的工作量优化。验收采用 1280×720 窗口留证；以后只有视觉后备读不清时再提高分辨率或局部放大。与初始 2326×1506 配置相比，1280×720 的像素数约减少 73.7%；这只是像素工作量计算，不能承诺 CPU/GPU 或模型费用等比例下降。BGRA 单帧约 3.52 MiB，当前 24-bit RGB 图约 2.64 MiB，PNG 和 base64 是另外的存储开销。

开启截图时，helper 每次新建 bitmap/graphics 并编码到文件。这便于留证，但后续若测得分配或写盘成本明显，可复用同尺寸 buffer、减少中间复制，并保留关键前后帧及失败帧。低频动作日志采用 JSON-lines；限制截图保留量，避免长时间运行持续占满磁盘。只有启用该后备时才是 Node 与 helper 两个额外常驻进程；默认没有 helper。常驻设计也不自动保证低占用，帧处理和缓存仍须有上限。

先建立三组相同窗口尺寸、渲染后端与场景的测量：游戏单独运行；游戏 + 空闲 Agent；游戏 + 实际闭环。分别测量不开截图和启用截图的配置，记录 Node、游戏及可选 helper 的 CPU 时间增量、working set/private bytes、GPU 引擎占用、截图/编码耗时与大小、模型请求耗时、动作数以及总战斗时间。先看额外开销和延迟分布，再决定是否需要 Rust/C++、AOT 或编码器优化；不先设一个未经本机测量的“CPU 低于 X%”承诺。

本轮单场验收已经使用普通非置顶窗口、其他窗口前台下的游戏截图、Node → Jev → mod 的真实动作和战斗到奖励的连续证据完成。教程 CU 发生在之前的单独处理步骤，应与本次战斗分开记述。后续仍需扩展版本/界面兼容、最小化完整战斗、多房间与资源基准；单元测试通过、消息投递成功、两张截图 hash 不同或一张奖励图，仍各自不足以支持新的广泛完成声明。
