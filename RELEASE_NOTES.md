# 🚀 FromZero Launcher v0.2.5
## ⚡ 性能与预览优化：Asset 直链、零 Base64、死代码清理

[![Tauri](https://img.shields.io/badge/Tauri-v2.x-blue?style=flat-square&logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-1.75+-orange.svg?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-green.svg?style=flat-square&logo=windows)](https://microsoft.com)

欢迎来到 **FromZero Launcher v0.2.5**！本版本聚焦**文件预览性能**与**运行时开销**，并清理了无用代码。

---

## ✨ 主要改进 (v0.2.5)

1. **🖼️ 文件预览零拷贝（Asset Protocol）**
   - 图片 / PDF / 音频 / 视频预览不再经 IPC 传输 Base64，后端仅返回元数据，前端通过 `convertFileSrc` 直读本地文件。
   - 修复 PDF 预览内容格式错误（此前错误前缀导致无法解码）。
   - 新增视频预览；文本预览行数/字节更合理，并过滤隐藏项。
   - 预览元数据缓存 + 请求序号取消，快速滑动列表时不再堆积过期请求。

2. **🚀 搜索与列表性能**
   - 应用搜索避免对拼音字段重复 `to_lowercase`，排序键只算一次。
   - 文件搜索复用已读取的 `metadata`，减少重复 `stat`。
   - 结果列表使用 `DocumentFragment` 批量插入；选中态仅更新前后两项 DOM。

3. **🎞️ 液态玻璃 GPU 开销**
   - 背景高斯模糊恢复半分辨率双通道（约 4× 更少 texel）。

4. **🧹 死代码清理**
   - 移除未使用的鼠标跟踪、离屏 canvas 变量、未引用的窗口常量。
   - 移除已无用的 `base64` 依赖。

---

## 📜 历史版本

### v0.2.4 — 稳定性与安全加固

1. **🎞️ 液态玻璃渲染单循环守卫**
   - 修复首次呼出窗口时 `focus` 事件与初始化路径可能同时启动**两条 WebGL 渲染循环**的问题，避免 GPU 占用翻倍与画面抖动。引入独立的渲染令牌（pump token），确保任意时刻仅有一条渲染循环存活，且不干扰看门狗的捕获恢复。

2. **⌨️ 全局热键状态一致性**
   - 重构快捷键注册逻辑为单一职责：解析失败时**完全不改动当前已绑定的热键**；绑定失败时不再残留半绑定状态。
   - 在设置中保存一个被占用/非法的组合键时，现在会**回滚到原热键**并提示错误，杜绝「原热键丢失、配置文件与实际绑定不一致」的问题。

3. **🔒 路径与文件打开安全收紧**
   - `is_safe_path` 现在明确拒绝设备命名空间路径（如 `\\.\PhysicalDrive0`）。
   - 打开文件的危险扩展名黑名单补齐（新增 `scf`、`inf`、`vbe`、`wsh`、`msp`、`mst`、`gadget`、`appref-ms` 等）。
   - `open_folder` 接入统一的 UNC 网络/共享路径拦截，与其它文件命令边界一致。

4. **🔍 文件搜索前缀残留修复**
   - 仅输入 `f ` / `find ` 前缀（尚无关键词）时，不再残留上一次的搜索结果，列表即时清空。

---

## 💎 过往重点回顾 (v0.2.3)

* **独立悬浮搜索框**：搜索框从顶部边缘解耦为独立圆角矩形，新增高度与下沉调节滑块。
* **WebGL 液态玻璃折射**：在 GPU 渲染管线上将实时桌面画面泵入 WebView，实现与桌面同频折射的液态玻璃效果（FPS 可调）。
* **自适应应用网格**：内容区被压缩时常用应用网格自动在 1 行 / 2 行间切换，避免图标挤压。
* **自拍隐身（反套娃）**：通过 `WDA_EXCLUDEFROMCAPTURE` 捕获排除，解决实时截屏的「镜中镜」无限套娃。

---

### 📦 绿色单包下载
* **fromzero-launcher-lite_0.2.4.exe** (~10.7 MB)
  > [!NOTE]
  > 免安装绿色单包，解压即用。旧系统（Win10 2004 以下）运行会自动降级回毛玻璃（Acrylic）模式。
* **fromzero-launcher_0.2.4_setup_x64.exe** — NSIS 安装包
