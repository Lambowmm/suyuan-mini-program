# 江苏溯源病理小程序

这是江苏溯源病理报告查询的原生微信小程序源码，用于微信开发者工具导入、预览、上传体验版和发布版本。

小程序前端位于 `pages/`、`utils/` 和 `components/`；`background/` 是本地后端参考代码，`docs/` 是本地接口文档，两者均已被 `.gitignore` 排除，服务器部署需单独处理。

## 当前测试版范围

- 首屏：医院病理/检验报告查询；存在 LIS 会话时默认进入检验模式
- 已开放：医院账号登录、按送检日期查询病理报告、报告搜索、报告查看和下载
- 已接入展示：接口返回的 `PatientName` 会展示为患者信息
- 下载命名：PDF / DOCX 会按 `溯源-病人姓名-报告类型` 生成本地文件名
- 检验：分页查询、姓名/异常/危急值筛选、条码展示、日期范围统计、PDF 查看/下载、令牌自动刷新
- 暂未开放：个人查询、个人资料维护
- 暂时隐藏：首页、我的；页面文件保留，当前不提供入口

## 后端接口

- 接口地址：`https://www.suyuanbingli.cn/tools/wxopen.ashx`
- 请求方式：`POST`
- 签名：参数按字段名排序，排除 `action` 和空值，末尾拼接接口密钥后 MD5，放入请求头 `signature`
- 病理列表：`reportList`
- 报告详情：`reportDetail2`
- 检验接口：`utils/lis.js` 直接调用 `https://www.suyuanbingli.cn/open`，使用 Bearer token；不再走每次凭密码登录的 `lisReportList` / `lisReportPdf` 代理。协议见本地 `docs/LIS_API_COMPACT.md`（不随 Git 仓库提交）。

## 目录说明

### 小程序运行文件

| 路径 | 用途 |
| --- | --- |
| `app.js` | 小程序初始化，保存当前报告查询条件及病理报告列表等内存状态 |
| `app.json` | 页面注册、窗口配置和 `style: "v2"` 设置 |
| `app.wxss` | 全局颜色、布局和通用样式 |
| `pages/report/index.*` | 病理/检验登录与查询入口；独立账号状态、统一报告日期范围选择，默认最近七天（含今天） |
| `pages/report/result.*` | 病理/检验报告列表；姓名搜索、日期修改、危急值/异常筛选、排序、分页及报告查看/下载 |
| `pages/index/`、`pages/mine/` | 预留首页和我的页面，仍在 `app.json` 注册，当前未提供入口 |
| `components/tdesign/` | TDesign MiniProgram 1.17.0 日历及其弹窗、按钮、图标等运行依赖；包含来源说明和许可证 |
| `components/tdesign/miniprogram_npm/` | 日历所需的 dayjs、tslib 等依赖，属于运行文件 |
| `utils/api.js` | 病理接口请求、参数构造及返回数据处理 |
| `utils/lis.js` | 检验登录、会话恢复、令牌刷新及 JSON/PDF 请求 |
| `utils/report-order.js` | 根据后端倒序分页结果计算正序分页数据 |
| `utils/date.js` | 日期范围和日期比较工具；登录页单独设置最近七天默认范围 |
| `utils/sign.js`、`utils/md5.js` | 病理接口签名计算 |
| `utils/config.example.js` | 接口地址和签名配置模板 |
| `utils/config.js` | 实际本地配置，运行时需要，但不提交 Git |
| `assets/tabbar/` | 预留底部导航图标，当前未引用 |
| `sitemap.json` | 小程序页面索引配置 |

### 开发工具与配置

| 路径 | 用途与提交方式 |
| --- | --- |
| `scripts/prepare-calendar.js` | 在开发电脑运行，提取官方日历依赖到 `components/tdesign/` 并调整引用路径 |
| `tests/lis.test.js` | 使用 Node.js 模拟微信环境和接口的回归测试 |
| `package.json` | 日历依赖版本及 `npm test`、`npm run prepare:calendar` 命令 |
| `package-lock.json` | 锁定 npm 依赖 |
| `project.config.json` | 微信开发者工具共享配置、AppID、基础库及上传排除规则 |
| `.gitignore` | Git 忽略规则 |
| `README.md` | 开发、目录结构、回归检查及发布说明 |

### 本地参考资料

- `background/`：ASP.NET 后端参考代码及运行依赖，单独部署，不提交当前仓库。
- `docs/LIS_API_COMPACT.md`：检验接口协议，位于被忽略的 `docs/` 目录，其他开发者需另行获取。

`components/` 是小程序运行代码，`scripts/` 和 `tests/` 是开发辅助代码，三者均应保留。当前 `project.config.json` 的 `packOptions.ignore` 只显式排除了 `scripts/` 和 `tests/`；本地 `background/`、`docs/` 的 Git 忽略规则不会自动成为微信上传排除规则。

## 开发运行

1. 使用微信开发者工具导入本目录
2. 项目 AppID：`wx761897028aa3ab19`
3. 复制 `utils/config.example.js` 为 `utils/config.js`，并填入实际接口签名密钥
4. 导入后建议先执行“清缓存并编译”
5. 上传体验版前建议真机验证：两种登录模式、日期确认/取消、搜索筛选、分页排序、查看报告和下载报告

日历运行文件完整时，无需额外执行微信开发者工具的“构建 npm”。需要安装依赖或重新生成日历文件时执行：

```bash
npm ci --ignore-scripts
npm run prepare:calendar
```

## 发布注意

- 当前 `project.config.json` 的基础库版本为 `latest`；如果开发者工具内部报错但业务功能正常，可切换到稳定基础库再验证。
- `assets/tabbar` 图标当前未引用，但为后续恢复首页/我的入口保留。
- 小程序接口依赖后端目录，后端改动需单独部署到服务器。
- `utils/config.js` 包含接口签名密钥，已加入忽略规则，不应提交到公开仓库。

