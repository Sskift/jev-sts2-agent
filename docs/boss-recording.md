# 第一幕 Boss 录制

运行 `node --use-system-ca scripts/run_recorded.mjs <ffmpeg.exe>`。FFmpeg 需要 `gfxcapture` 和 `h264_nvenc`，当前机器 RTX 4060 已实际验证。使用 Windows Graphics Capture 按游戏进程的真实 HWND 选窗口，720p、20fps、H.264；不录桌面或麦克风，当前无音轨。遮挡不要求切换焦点，最小化时不进入待录的 Boss。

主循环在发送第一幕 BOSS 的地图动作之前等待首批视频帧，再重新读取状态并核对动作。观察到战斗后，首次奖励、正式失败或进入第二幕会保留三秒结束画面，然后封装 MP4。录制不参与 Jev 选择，主循环普通出牌沿用原逻辑。

录制工作进程独立于决策循环。暂停或重启 Node 主循环时仍然录制，后续同局可接回；`run-artifacts/boss-recording.json` 保存 armed/recording/complete 等状态和视频位置。录制异常时保留分段 MP4 与日志，并停止后续自动动作等待检查。一次请求只录下一场第一幕 Boss，完成后不会自动再次录制。更换请求需要先确认没有运行中的录制，再归档 manifest。

用户要求发给自己的飞书账号 liushiao / 刘世傲，并最终要求只发送击杀前后最后约 30 秒。OpenLark `http://127.0.0.1:3333/api/me` 与搜索结果核实为同一个用户，已建立本人会话。当前 OpenLark API 未实现文件/视频上传发送，用户随后允许 Computer Use 操作飞书客户端上传原视频。录制脚本只保存本地文件，剪辑与发送由已获授权的任务执行并核验，不能把本地保存说成已送达。

2026-09-20 第十九局 Vantom 实际录制已完成。原片 322.75 秒，目录 `run-artifacts/boss-1789880075360`。核对最后攻击的原生状态与实际画面后，取原片 287.5–317.5 秒并重新编码为 `Vantom-boss-final-30s.mp4`，实际时长 29.95 秒、6,894,684 字节，包含第 13 回合 Pommel Strike 的击杀与死亡动画。通过飞书客户端勾选原视频发送给本人；OpenLark 返回同文件名、同大小、`localState: synced`，客户端显示 00:30 视频。原片、剪辑和发送回执均保留本地忽略目录，不上传 Git。

FFmpeg 官方 [gfxcapture 源码及选项](https://ffmpeg.org/doxygen/trunk/vsrc__gfxcapture_8c_source.html) 说明 HWND、帧率和窗口缩放参数。二进制从 [官方列出的 Windows 构建提供方 Gyan](https://www.gyan.dev/ffmpeg/builds/) 下载到本地忽略目录，不纳入仓库。
