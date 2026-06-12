# 🚀 FromZero Launcher v0.2.3-preview
## 🌌 液态玻璃：真·实时折射与自适应定制

[![Tauri](https://img.shields.io/badge/Tauri-v2.x-blue?style=flat-square&logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-1.75+-orange.svg?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-green.svg?style=flat-square&logo=windows)](https://microsoft.com)

欢迎来到 **FromZero Launcher v0.2.3-preview**！在此版本中，我们为“液态玻璃”视觉效果提供了更强大的自适应布局与美术可定制性。

---

## 🎨 醒目大字：v0.2.3-preview is coming!

### 🌟 关键更新说明 (v0.2.3-preview)

1. **📐 独立悬浮搜索框**
   - 搜索框从顶部边缘完全解耦，改造成独立的圆角矩形，更加轻盈悬浮，避免了与顶部圆角、斜角的视觉冲突。
   - 在设置中新增了 **搜索框高度** (`30px - 80px`) 和 **搜索框下沉** (`0px - 150px`) 调节滑块，支持更自由的界面比例配置。

2. **⚡ 自适应应用网格 (Space-Aware Row Slicing)**
   - 常用应用网格增加了自适应高度监控。当搜索框下沉导致下部内容区域被压缩时，应用网格会自动收缩至 **1 行 (4 个应用)**，避免图标被遮挡或挤压变形。
   - 在空间充足时，自动恢复展示 **2 行 (8 个应用)**；并在极限下沉情况下，严格维持 **1 行 (4 个应用)** 的基本底线，保证功能完备性。

3. **⚙️ 布局参数全持久化**
   - 新增的搜索框高度与下沉偏移量已全面接入 Rust 后端设置存储，完美实现跨会话状态保持。

---

## 💎 过往重点回顾 (v0.2.2)

* **实时桌面折射**：直接在 GPU 渲染管线上将整个桌面的实时画面泵入 WebView 内部，实现了真正与桌面背景同频呼吸、折射光影的液态玻璃效果（60 - 120 FPS 可调）。
* **自拍隐身（反套娃）**：通过 `WDA_EXCLUDEFROMCAPTURE` 捕获排除，彻底解决实时截屏导致“镜中镜”无限套娃自拍的死循环。
* **防边缘空洞采样**：背景 Canvas 负外边距外扩采样，根治了折射露出黑边的空洞隐患。

---

### 📦 绿色单包下载
* **[fromzero-launcher-lite_0.2.3-preview.exe](https://github.com/LevenST24/fromzero-launcher/releases/download/v0.2.3-preview/fromzero-launcher-lite_0.2.3-preview.exe)** (~10.4 MB)
  > [!NOTE]
  > 免安装绿色单包，解压即用。旧系统（Win10 2004 以下）运行会自动降级回毛玻璃（Acrylic）模式。
