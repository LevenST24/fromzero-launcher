# 🌌 FromZero Launcher

[![Tauri v2](https://img.shields.io/badge/Tauri-v2.x-blue.svg?style=flat-square&logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-1.75+-orange.svg?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-green.svg?style=flat-square&logo=windows)](https://microsoft.com)
[![License](https://img.shields.io/badge/License-MIT-brightgreen.svg?style=flat-square)](LICENSE)

**FromZero Launcher** 是一款为 Windows 10/11 深度定制的极简、高性能优雅应用启动器。为了摆脱杂乱的桌面快捷方式，它采用最新的 **Tauri v2 + Rust + Vanilla JS/HTML/CSS** 架构构建，内存占用仅 **~18MB**，搜索检索响应时间 **< 1ms**。

---

## 🎨 核心视觉与交互设计 (Design & Aesthetics)

1. **🎨 极致的 Fluent Design 毛玻璃视觉**
   * **系统级模糊**：Rust 后端深度调用 Windows API，在 Windows 10/11 上渲染出清澈通透的 **Acrylic（亚克力）** 或 **Mica（云母）** 系统级物理模糊效果，不占用 CPU 资源。
   * **动态卡片层叠与动效**：界面采用层级微动画（如级联式淡入淡出、卡片悬浮放大、阴影微光等），体验尊贵。

2. **⌨️ 全方位键盘驱动**
   * **全局快捷键**：默认使用 **`Alt+Space`** 全局呼出/隐藏窗口，支持在设置面板中**录制并绑定自定义快捷键**！
   * **失去焦点自动隐藏**：一旦点击其他应用或桌面，启动器会在 120ms 内瞬间优雅收起，绝不驻留屏幕干扰视线。

3. **⚡ 智能应用扫描与拼音模糊检索**
   * **递归全盘扫描**：多线程递归扫描系统与用户的开始菜单快捷方式（100% 兼容 Win32 应用与 UWP 磁贴应用）。
   * **拼音首字母 + 全拼检索**：在内存中建立高效索引树，支持拼音首字母匹配（如输入 `wx` 即可精准命中 `微信`）与全拼模糊检索，响应速度近乎瞬间。

4. **🌐 极速网络搜索引擎重定向**
   * 支持通过简单前缀直接带着内容重定向浏览器搜索，例如：
     * `g 天气` — 直接在默认浏览器中通过 Google 搜索 `天气`
     * `b FromZero` — 直接通过 百度 搜索 `FromZero`
     * `bi Tauri` — 直接通过 Bing 搜索 `Tauri`
     * `gh antigravity` — 直接在 GitHub 检索 `antigravity`

5. **📂 快速文件夹定位导航**
   * 以 `/` 开头或直接输入 Windows 路径（如 `D:\Projects`、`C:\Windows`），按下回车即可在文件资源管理器中瞬间弹窗定位并打开目标文件夹。

6. **⚙️ 系统快捷指令集成**
   * 输入 `>` 符号即可调出系统命令快捷菜单：
     * `> lock` — 锁定计算机屏幕
     * `> sleep` — 计算机休眠
     * `> shutdown` — 立即关闭计算机
     * `> restart` — 立即重新启动计算机

---

## 🛠️ 图标提取技术与无感增量刷新

FromZero Launcher 包含一套优雅的图标解析与加载管道：
* **多线程后台提取**：冷启动或加入新应用时，为了保证首帧 `< 10ms` 极限载入，Rust 会在后台开辟单独的线程，使用 PowerShell COM 组件从可执行文件中异步抽取高清 `PNG` 图标，并自动 md5 命名缓存于 `AppData\Local`。
* **局部无感动态注入**：当某个图标在后台提取完毕后，Rust 会向前端发送 `icon-ready` 级联通知。前端监听到事件后直接对其对应的 DOM 进行增量重绘，**绝不进行全表刷新**，防止干扰您的打字进度、光标焦点与键盘选中位置。

---

## 🚀 开发者指南

### 依赖环境
* [Node.js](https://nodejs.org/) (用于 Tauri 命令行调度)
* [Rust](https://www.rust-lang.org/) 及 Microsoft C++ Build Tools (Tauri v2 底层编译依赖)

### 1. 运行开发服务器 (Tauri Dev)
```bash
# 安装依赖
npm install

# 启动开发服务器
npm run tauri dev
```
运行后双击系统托盘图标，或按下 **`Alt+Space`** 即可呼出启动器面板！

### 2. 打包编译单文件发布版
```bash
npm run tauri build
```
编译完成后，会在 `src-tauri/target/release/` 下生成一个极致小巧的独立单文件程序 **`fromzero-launcher.exe`**，双击即可无依赖独立运行，占用内存低于传统框架！

---

## 📂 项目结构

```
fromzero-launcher/
├── README.md               # 项目技术规格文档
├── package.json            # 前端依赖配置
├── src-tauri/
│   ├── Cargo.toml          # Rust 依赖声明
│   ├── tauri.conf.json     # Tauri 核心全局配置 (包含 Asset 协议与窗口参数)
│   ├── capabilities/       # Tauri v2 细粒度权限安全控制
│   │   └── default.json
│   └── src/
│       ├── lib.rs          # 核心入口：Mica/Acrylic亚克力模糊、窗口焦点管理、托盘事件
│       ├── settings.rs     # 系统配置（快捷键等）持久化读取与写入
│       ├── indexer.rs      # 开始菜单高速索引、拼音分析、后台图标抽取管道
│       └── commands.rs     # 进程调度、系统锁定、搜索与快捷键录制等 Rust IPC 接口
└── src/
    ├── index.html          # 主窗口 DOM 与自定义快捷键设置悬浮面板
    ├── styles.css          # Fluent 风格主题、磨砂玻璃拟物背景、平滑滑块动画
    └── main.js             # 路由控制、键盘事件监听、增量图标动态映射、IPC IPC通讯
```

---

## 📜 开源协议

本项目采用 [MIT License](LICENSE) 开源协议。
