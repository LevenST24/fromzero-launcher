## FromZero Launcher v0.1.6 复查报告

复查日期: 2026-06-08 | 项目类型: Tauri 2 桌面应用 (Rust + Vanilla JS)

---

### 一、上次问题修复验证

#### 严重问题（3项）

| # | 问题 | 状态 | 说明 |
|---|------|------|------|
| 1 | `currentDirPath` 未声明 | **已修复** | 第63行 `let currentDirPath = null;` 与其他状态变量一起声明 |
| 2 | `hidePreview`/`triggerPreview`/`getFileIcon` 未定义 | **已修复** | 三个函数均已实现：`getFileIcon`(985-1000行)、`showPreview`(1003-1070行)、`hidePreview`(1073-1076行)、`triggerPreview`(1079-1083行)，预览面板功能完整 |
| 3 | `handleGlobalKeys` 大括号嵌套错误 | **已修复** | Backspace 分支(764-771行)大括号层级正确，与 Enter/Escape 分支对齐 |

#### 中等问题（5项）

| # | 问题 | 状态 | 说明 |
|---|------|------|------|
| 4 | DWM API 代码重复 | **已修复** | 新增 `dwm.rs` 模块，提取公共函数 `set_dwm_attribute()`。`lib.rs` 和 `commands.rs` 均调用此函数 |
| 5 | `search_files` 同步阻塞主线程 | **已修复** | `search_files`、`list_directory`、`get_file_preview`、`scan_apps` 均改为 `async` + `tokio::task::spawn_blocking`，Cargo.toml 已添加 tokio 依赖 |
| 6 | 版本号重复维护 | **未修复** | `APP_VERSION` 仍在 main.js(100行) 和 index.html(67行) 中硬编码。低优先级，可后续处理 |
| 7 | Settings 结构体格式化 | **已修复** | 各字段独立一行，格式规范 |
| 8 | `setBlurTimeout` 使用在声明前 | **未修复** | 仍在第191行使用、第197行声明。当前不会触发问题（仅在 DOMContentLoaded 后调用），但代码脆弱 |

#### 安全问题（2项）

| # | 问题 | 状态 | 说明 |
|---|------|------|------|
| 9 | 良好安全实践 | **保持** | 白名单、协议限制、CSP 等安全措施完好 |
| 10 | 路径规范化 | **已修复** | `list_directory`(379行)、`get_file_preview`(525行)、`open_file`(625行) 均添加了 `canonicalize()`；新增 `clean_path_str` 辅助函数去除 `\\?\` 前缀 |

#### 架构与设计建议（6项）

| # | 问题 | 状态 | 说明 |
|---|------|------|------|
| 11 | 前端单文件过大 | **未修复** | main.js 增至1084行（新增预览功能）。可后续模块化 |
| 12 | 设置持久化策略不一致 | **已修复** | 新增 `GlassSettings` 结构体(settings.rs 9-26行)，玻璃设置纳入 `Settings` 统一管理；前端从 `settings.glass_settings` 读取，保存时写入 `settings.glass_settings`，不再使用 localStorage |
| 13 | 搜索性能优化 | **未修复** | `sort_by` 中仍每次比较调用 `to_lowercase()`。低优先级 |
| 14 | `withGlobalTauri` 设置 | **保持现状** | 当前模式合理 |
| 15 | Light 主题 `select option` 硬编码 | **未修复** | styles.css 871-874行仍硬编码暗色背景 |
| 16 | 过渡效果不一致 | **未修复** | `result-item` 的 transition 仍缺少 `transform` |

---

### 二、修复统计

| 分类 | 总数 | 已修复 | 未修复 |
|------|------|--------|--------|
| 严重问题 | 3 | **3** | 0 |
| 中等问题 | 5 | **3** | 2 |
| 安全问题 | 2 | **2** | 0 |
| 设计建议 | 6 | **1** | 5 |
| **合计** | **16** | **9 (56%)** | **7** |

---

### 三、新增改进亮点

**1. 完整的文件预览系统**

新增了 `showPreview`、`hidePreview`、`triggerPreview` 函数，支持图片 Base64 预览、文本前30行预览、文件夹内容列表预览。预览面板带有 150ms 防抖，防止快速切换时闪烁。同时新增 `formatFileSize` 和 `formatDate` 辅助函数，展示文件大小和修改时间。

**2. DWM 模块抽象**

新增独立的 `dwm.rs` 模块，将所有 `DwmSetWindowAttribute` 调用统一到单一函数中。这不仅消除了代码重复，还将 `unsafe` 代码集中在一个文件里，降低了维护风险。

**3. 异步文件操作**

`scan_apps`、`search_files`、`list_directory`、`get_file_preview` 全部改为 async 命令，使用 `tokio::task::spawn_blocking` 包装 I/O 密集型操作。这显著提升了 UI 响应性，特别是大目录浏览和文件搜索场景。

**4. 路径安全加固**

`canonicalize()` 被应用于 `list_directory`、`get_file_preview`、`open_file`，防止 `..` 路径穿越攻击。`clean_path_str` 辅助函数去除 Windows 长路径前缀 `\\?\`，避免路径比较时的不一致问题。

**5. 玻璃设置统一管理**

`GlassSettings` 结构体被纳入 `Settings`，前端通过 `settings.glass_settings` 读写，保存时随统一 settings 对象持久化到 JSON 文件。取消操作仍能正确恢复备份值。

**6. 目录导航逻辑简化**

`executeItemAction` 中的目录处理从条件分支简化为统一的下钻逻辑，点击文件夹始终更新路径并进入子目录，行为更加可预测。

---

### 四、仍可改进的残留项

以下问题不紧急，但建议在后续迭代中逐步处理：

**1. `setBlurTimeout` 声明位置（低风险）**

当前 `let setBlurTimeout = null;` 在 `applyVisualSettings` 函数之后声明。虽然目前仅在 DOMContentLoaded 后调用该函数，不会触发 TDZ 错误，但如果将来有人重构初始化顺序，可能意外触发。建议将这行移到第64行附近，与 `previewDebounceTimeout` 放在一起。

**2. Light 主题 `select option` 背景**

styles.css 第871-874行的 `.settings-select option` 硬编码了 `background: #1a1a24; color: #fff;`。在 Light 主题下，下拉选项会是深色背景，与整体浅色界面不协调。可以添加一条 Light 主题覆盖规则。

**3. `result-item` 过渡效果**

`.result-item` 的 `:active` 使用了 `transform: scale(0.985)`，但 transition 列表中没有 `transform`，导致按压动画缺少过渡。建议在 styles.css 第539行的 transition 中补充 `transform 0.1s`。

**4. 版本号动态获取**

`APP_VERSION` 硬编码在 main.js 和 index.html 中。可以在初始化时通过 Tauri 的 `getVersion()` API 动态获取，HTML footer 的初始文本也由 JS 动态填充。

**5. 前端模块化**

main.js 已超过1000行。虽然功能划分清晰（通过注释分隔符），但物理上仍是单文件。未来可考虑拆分为 `search.js`、`settings.js`、`preview.js`、`ui.js` 等模块。

---

### 五、结论

上次的 **3项严重运行时 Bug 全部修复**，核心的 DWM 代码重复、同步阻塞、设置持久化不一致、路径安全等中等问题也已解决。代码质量有明显提升，新增的文件预览系统实现完整。剩余的7项未修复问题均属于低优先级的优化建议，不影响功能正确性和稳定性。整体代码已处于可发布状态。
