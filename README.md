# 🌌 FromZero Launcher

[![Tauri v2](https://img.shields.io/badge/Tauri-v2.x-blue.svg?style=flat-square&logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-1.75+-orange.svg?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-green.svg?style=flat-square&logo=windows)](https://microsoft.com)
[![License](https://img.shields.io/badge/License-MIT-brightgreen.svg?style=flat-square)](LICENSE)

**FromZero Launcher** 是一款专为 Windows 10/11 深度定制的极简、高性能与视觉奢华并重的桌面助手及本地工作空间导航器。为解决桌面混乱而生，项目基于 **Tauri v2 + Rust + Vanilla JS/HTML/CSS** 现代架构构建，以极低的空间开销（**约 18MB 内存占用**）及卓越的响应速度（**检索耗时 < 1ms**），提供融会原生亚克力（Acrylic）视觉与高频操作体验的数字绿洲。

---

## 🎨 核心特性与优雅设计

### 1. 拟物化液态玻璃视觉 (Liquid Glass & Fluent Design)
* **系统级高级模糊**：Rust 后端直接调用 Windows 原生 DWM 接口，在 Win10/11 窗口底层完美渲染出清澈通透的 **Acrylic（亚克力）** 物理磨砂玻璃纹理。
* **柔和渐变与动态边框**：窗口周围环绕着根据系统明暗主题自适应的渐变高光边框，与内部级联式卡片动效融为一体，呼出与隐藏流畅自然。
* **无感失焦收起**：失去输入焦点后在 120ms 内优雅渐隐隐藏，绝不驻留屏幕干扰视线。

### 2. 交互分流：单击预览，双击运行 (Double-Click Execution)
为了提供专业且安全的文件交互逻辑，Launcher 引入了**动作分流机制**：
* **单击选中**：选中列表项并仅更新右侧的**多模态预览面板**，避免任何误触导致的不安全可执行程序执行。
* **双击或回车 (Enter)**：确认为目标项目后，双击或按下回车将通过安全沙箱调用系统默认程序打开文件、运行白名单程序或执行动作。

### 3. 多模态本地内容实时预览 (Interactive Previews)
右侧预览面板会根据选中文件的类型智能呈现高还原度的多模态内容：
* **🖼️ 图片预览**：支持 `.png`、`.jpg`、`.gif`、`.webp`、`.svg` 等主流格式的自适应缩略图渲染。
* **📄 PDF 预览**：后端安全读取 PDF 字节流并转化为沙箱级 Blob URL，在独立 `<iframe>` 中完整展示 PDF 排版与图表。
* **🎵 音频预览**：深度适配 `.ogg`（语音素材、音效）、`.mp3`、`.wav` 等音频文件，在右侧原位生成包含播放/暂停、进度条、音量调节的高清音频播放器。
* **💻 文本预览**：对代码文件或文本文档自动呈现首 30 行内容（限制文本长度以保证大文件瞬时载入的流畅度）。
* **📁 目录预览**：选中文件夹时，预览区域将直接树状列出该目录下的前 10 项子目录或文件。

### 4. 融合物理位移检测的悬浮滑动选择 (Scroll-Safe Hover Selection)
* **光标滑动即选中**：鼠标光标在左侧结果列表中轻轻拂过时，即可瞬时选中项目并切换右侧预览（仅 50ms 极短防抖延迟）。
* **滚动拦截算法 (Scroll Protection)**：在滚轮滚动列表时，为防止位置位移导致列表项目在静态光标下移动从而错误触发 `mouseenter` 事件造成回弹或卡顿，我们引入了屏幕坐标差值（Screen Coordinate Delta）校验机制。只有当用户**真正物理移动鼠标**时才会引发选中状态更新，使鼠标滚轮滚动流畅自然。

### 5. 本地文件导航与拼音模糊检索 (File Explorer & Pinyin Search)
* **拼音首字母 + 全拼模糊搜索**：内存中构建高效的中文索引树，键入 `wx` 瞬时定位 `微信`。
* **目录直接导航**：直接输入盘符或绝对路径（如 `C:\Windows`、`E:\yuzusoft`），即可展开目录结构并支持按 `Backspace` 快速返回上级目录。
* **多盘模糊搜索**：支持在全局使用 `f 关键词`（或 `find 关键词`）瞬间扫描检索系统常用文件夹与外置驱动器中的文件。

### 6. 网络重定向与系统控制指令 (Web Redirect & System Command)
* **搜索引擎重定向**：支持类似 `g Tauri`（Google 检索）、`b Rust`（百度检索）的前缀直接调用默认浏览器。
* **系统指令集**：通过 `>` 触发控制指令：`> lock`（锁屏）、`> sleep`（休眠）、`> shutdown`（关机）及 `> restart`（重启）。

---

## 🏗️ 核心技术架构设计

```
                         Tauri IPC (Command Channel)
       ┌─────────────────────────────────────────────────────────────┐
       │                                                             │
       ▼                                                             ▼
┌──────────────┐          ┌──────────────────────┐        ┌──────────────────────┐
│  Webview     │          │  Tauri Rust Core     │        │  Windows OS          │
│  (Frontend)  │          │  (Backend)           │        │  (System APIs)       │
├──────────────┤          ├──────────────────────┤        ├──────────────────────┤
│ Vanilla JS   │  Invoke  │ spawn_blocking       │  Call  │ DWM Acrylic Blur     │
│ CSS Grid     │ ────────►│ (Tokio Thread Pool)  │ ──────►│ GetLogicalDrives     │
│ Blob Manager │          │ Async File IO        │        │ ShellExecuteW        │
└──────────────┘          └──────────────────────┘        └──────────────────────┘
```

* **Tokio 异步 IO 隔离**：高频的盘符扫描与文件读取任务全部封装在 `spawn_blocking` 中执行，彻底杜绝主 UI 线程阻塞。
* **无感增量重绘管道**：PowerShell 异步抽取的快捷方式高清 PNG 图标缓存至本地，并在提取完成后通过 `icon-ready` 事件局部更新 DOM，绝不引发全表刷新从而导致输入光标或键盘聚焦失效。
* **内存安全 Blob 周期管理**：PDF 与音频的预览采用动态对象化管理。在切换选中或关闭面板时，JS 会自动 Revoke 之前创建的 Blob URL，避免长期驻留导致垃圾回收（GC）堆积和内存溢出。

---

## 🚀 开发者指南

### 环境依赖
* **Node.js** (推荐 v18+) - 用于前端构建及 Tauri CLI 调度。
* **Rust** (推荐 1.75+) 及 Microsoft C++ Build Tools - 用于编译底层高性能二进制模块。

### 1. 本地开发调试
```bash
# 安装开发依赖
npm install

# 启动热重载开发模式 (Tauri Dev)
npm run tauri dev
```
启动后，按全局默认快捷键 **`Ctrl+Space`** (或自定义快捷键) 即可随时在系统前台唤起或渐隐隐藏启动器。

### 2. 生成发布生产包
```bash
npm run tauri build
```
编译成功后，在 `src-tauri/target/release/` 下将产出一个仅约 **10MB** 且**无任何外部运行库依赖**的超小独立主程序 `fromzero-launcher.exe`。

---

## 📂 项目模块规格说明

```
fromzero-launcher/
├── README.md               # 本项目技术规格及使用指南文档
├── package.json            # 前端依赖配置与构建脚本
├── src-tauri/
│   ├── Cargo.toml          # Rust 依赖及静态/动态库构建定义
│   ├── tauri.conf.json     # Tauri 全局配置文件 (包含 CSP 与权限作用域)
│   ├── capabilities/       # Tauri v2 细粒度权限安全配给
│   │   └── default.json
│   └── src/
│       ├── lib.rs          # 核心生命周期、原生亚克力毛玻璃、托盘事件集成
│       ├── settings.rs     # 全局持久化设置（包括自定义快捷键、视觉强度）管理
│       ├── dwm.rs          # Windows 原生 DWM 及亚克力混合接口动态包装实现
│       ├── indexer.rs      # 多线程开始菜单遍历、拼音首字母建树、后台异步提取图标
│       └── commands.rs     # 系统安全锁、异步文件查找、目录导航及预览流 Rust 接口
└── src/
    ├── index.html          # 主窗口骨架结构与设置抽屉面板
    ├── styles.css          # Fluent Design 视觉风格、磨砂边框高光与分栏动画样式
    └── main.js             # 滑动防抖路由、按键组合录制、增量 DOM 更新与 Blob URL 释放管理
```

---

## 📜 开源协议

本项目基于 [MIT License](LICENSE) 协议开源，允许任何形式的个人与商业合理二次开发与重构。
