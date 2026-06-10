# 🧪 FromZero Launcher v0.2.2-preview
## 🌌 液态玻璃终局版：真·实时桌面折射！

[![Tauri](https://img.shields.io/badge/Tauri-v2.x-blue?style=flat-square&logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-1.75+-orange.svg?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-green.svg?style=flat-square&logo=windows)](https://microsoft.com)

此版本突破了网页端透明窗口的物理限制，通过高频 Direct3D11 实时捕获管线，实现了真正与桌面背景同频呼吸、折射光影的液态玻璃效果。

---

### ✨ 核心特性

* **💎 真·实时桌面折射**：背景不再是一张死图。无论背后在播放视频、拖动窗口还是启动器本身位移，折射画面都以 **60 FPS** 实时追踪。
* **🚫 自拍隐身（反套娃）**：启用 `WDA_EXCLUDEFROMCAPTURE` 捕获排除，彻底解决实时截屏导致“镜中镜”无限套娃自拍的死循环。
* **⚡ 极速性能重构**：Rust 端 2x 像素智能降采样 + 前端动态时间差帧同步，数据量直减 75%，在保持透镜清晰度的同时将延迟降为 0。
* **📐 紧凑防边缘破洞**：窗口保持 `640x450` 尺寸（不拦截透明留白区点击），背景 Canvas 负外边距外扩采样，根治了折射露出黑边的空洞隐患。

---

### 📦 最终章测试单包

* **[fromzero-launcher-lite_0.2.2-preview.exe](fromzero-launcher-lite_0.2.2-preview.exe)** (~10.3 MB)
  > [!NOTE]
  > 免安装绿色单包，解压即用。旧系统（Win10 2004 以下）运行会自动降级回毛玻璃（Acrylic）模式。
  >
  > ⚠️ 启用排除后，OBS 录屏/截图/屏幕共享时，启动器窗口在录像中会透明不可见，属于系统安全行为。
