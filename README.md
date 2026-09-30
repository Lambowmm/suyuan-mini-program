# 江苏溯源病理微信小程序

原生微信小程序，提供病理报告查询、LIS 检验报告查询和医院耗材采购。小程序前端由本仓库管理，采购服务沿用现有 ASP.NET 后台，后台源码及部署资料在本地单独维护。

授权方式：本仓库自主开发的软件代码采用 [PolyForm Noncommercial License 1.0.0](LICENSE)，允许符合许可条款的非商业使用、修改和再分发；商业用途需另行取得授权。第三方组件遵循各自许可证。

## 目录

- [功能与业务边界](#功能与业务边界)
- [技术栈与环境要求](#技术栈与环境要求)
- [快速开始](#快速开始)
- [配置与接口](#配置与接口)
- [项目结构](#项目结构)
- [开发与测试](#开发与测试)
- [后台部署](#后台部署)
- [小程序发布](#小程序发布)
- [常见问题](#常见问题)
- [贡献与提交约定](#贡献与提交约定)
- [许可证](#许可证)

## 功能与业务边界

小程序默认进入首页，底部导航包含四个页面：

| 页面 | 功能 |
| --- | --- |
| 首页 | 报告查询和耗材采购入口 |
| 报告查询 | 病理、LIS 独立登录与报告查询 |
| 耗材采购 | 获得采购权限后的商品目录、详情、购物车和下单 |
| 我的 | 微信登录、手机号绑定、采购准入申请、订单和月度对账入口 |

### 报告查询

- 病理与 LIS 保持独立账号、接口和会话体系；报告查询不要求绑定小程序采购账号。
- 支持报告日期范围选择，默认最近七天（含今天）。
- 病理支持报告列表、姓名搜索、详情查看及文件下载。
- LIS 支持分页、排序、姓名搜索、异常和危急值筛选、条码展示及 PDF 查看和下载，使用独立令牌和自动刷新机制。

### 耗材采购

采购流程：微信登录 → 绑定手机号 → 提交采购准入申请 → 后台审核并关联医院 → 浏览耗材 → 加入购物车 → 确认下单 → 分批配送 → 确认收货 → 月度对账。

- **物料资料**：品名、规格、型号、基础单位、参考销售价、厂家、包装说明、编码、凭证号等；支持商品图片、注册证和说明书附件。
- **包装与准入**：多级包装换算为基础单位；客户可采购的物料和单位由后台配置。
- **价格与赠品**：参考价、客户默认折扣及生效期特殊价格规则；`FREE` 赠品沿用普通订单和配送流程，金额为零。
- **订单与验价**：保存物料、换算和价格历史快照；服务端校验购物车，验价失败禁止结算，报价变化需要重新确认；提交重试保留原请求以避免重复下单。
- **账号隔离**：本地购物车按用户和医院隔离，审批提示按用户隔离；医院业务数据按客户权限访问。
- **库存与配送**：单仓库、基础单位库存记账，保留生产批号和有效期；支持分批出库和配送，物流人员分配送货员，送货员开始配送并确认送达。
- **收货与结算**：可手动确认收货，送达满七天自动确认；按客户和确认收货所属自然月生成对账明细，防止发货明细重复结算。
- **报表**：后台提供订单、发货及结算 Excel；客户通过小程序导出本医院订单和结算数据。

当前范围不包含微信支付、银行付款审批、发票上传、实时物流轨迹，以及退货、换货、结算冲销。对外报表 API 留待后续扩展。

## 技术栈与环境要求

| 部分 | 技术或要求 |
| --- | --- |
| 小程序 | 原生 JavaScript、WXML、WXSS；微信开发者工具 |
| 日历组件 | TDesign MiniProgram `1.17.0`，运行依赖已保存在 `components/tdesign/` |
| 开发脚本与测试 | Node.js、npm；需支持 `node --test`，建议使用受支持的 Node.js LTS 版本 |
| 现有后台 | IIS、ASP.NET / .NET Framework 4.0、SQL Server、既有 SWcms 程序集 |

`package.json` 尚未约束 Node.js 版本。`project.config.json` 当前将微信基础库设置为 `latest`，发布前应在实际目标基础库和真机上验证。

## 快速开始

1. 获取仓库并进入项目根目录。
2. 创建本地配置：

   ```powershell
   Copy-Item utils/config.example.js utils/config.js
   ```

3. 编辑 `utils/config.js`，填写正确的接口地址和签名配置，详见[配置与接口](#配置与接口)。
4. 使用微信开发者工具导入项目根目录，使用有权限的 AppID。现有共享配置的项目名为 `SYBL-Mini-Program`。
5. 清缓存并编译，验证首页、报告查询、耗材采购和我的页面。

仓库内日历运行文件完整时，无需执行微信开发者工具的“构建 npm”。安装开发依赖和运行测试：

```powershell
npm ci --ignore-scripts
npm test
```

只有需要重新生成日历运行文件时才执行：

```powershell
npm run prepare:calendar
```

该命令会更新 `components/tdesign/`，完成后需检查差异和日历显示。

## 配置与接口

配置模板为 [`utils/config.example.js`](utils/config.example.js)。实际配置 `utils/config.js` 是运行必需文件，但已被 Git 忽略。

| 配置项 | 用途 | 模板默认值 |
| --- | --- | --- |
| `API_HOST` | 病理与采购 API 入口 | `https://www.suyuanbingli.cn/tools/wxopen.ashx` |
| `LIS_API_HOST` | LIS 独立 API 根地址 | `https://www.suyuanbingli.cn/open` |
| `APP_SECRET` | 病理与采购请求签名配置，需与后端一致 | `REPLACE_WITH_APP_SECRET` |

`APP_SECRET` 与微信公众平台的 AppSecret 是不同配置。微信 AppSecret 由服务器后台维护，不应填入小程序前端。

| 业务 | 接口与鉴权 |
| --- | --- |
| 病理 | `utils/api.js` 请求 `API_HOST`，使用既有签名协议；列表为 `reportList`，详情为 `reportDetail2` |
| LIS | `utils/lis.js` 请求 `LIS_API_HOST`，使用 Bearer token，不依赖采购会话 |
| 采购 | `utils/procurement.js` 请求 `API_HOST` 的 `proc_*` 动作，使用签名与采购会话令牌 |
| 采购附件与导出 | 后台 `/tools/proc_download.ashx`，按相应用户权限提供文件 |

微信公众平台需配置实际使用的合法请求域名和下载域名。切换环境时同时核对 API 地址、文件下载地址和服务器配置。

## 项目结构

```text
.
├── app.js / app.json / app.wxss   # 应用初始化、页面注册、导航和全局样式
├── pages/
│   ├── index/                    # 首页
│   ├── report/                   # 病理与 LIS 查询、结果页
│   ├── order/                    # 耗材目录、详情、购物车、结算、订单列表
│   └── mine/                     # 我的、准入申请、月度对账
├── utils/                        # 配置、签名、报告与采购请求、日期和排序工具
├── components/tdesign/           # 日历及其运行依赖、第三方许可证
├── assets/tabbar/                # 底部导航图标
├── scripts/prepare-calendar.js   # 日历运行依赖生成脚本
├── tests/                        # 报告与采购测试
├── project.config.json          # 微信开发者工具共享配置和上传排除规则
├── package.json / package-lock.json
└── README.md
```

以下目录或文件仅存在于配套本地工作区，不能假设克隆仓库后自动获得：

| 路径 | 用途 | Git 管理 |
| --- | --- | --- |
| `background/` | ASP.NET 后台、迁移 SQL、后台页面、模板和程序集 | 忽略，需单独交付和部署 |
| `docs/` | 本地接口及业务资料 | 忽略，需另行获取 |
| `.ai/` | 实施任务和交付报告 | 忽略 |
| `utils/config.js` | 当前环境前端配置 | 忽略，需本地创建 |
| `project.private.config.json` | 微信开发者工具个人设置 | 忽略 |

`.gitignore` 控制 Git 跟踪，`project.config.json` 的 `packOptions.ignore` 控制微信上传包，两者互不替代。`components/tdesign/miniprogram_npm/` 是需要保留的运行依赖，不能与根目录 npm 输出混淆。

## 开发与测试

```powershell
npm test
```

测试命令运行以下文件：

| 文件 | 主要覆盖范围 |
| --- | --- |
| `tests/lis.test.js` | LIS 会话、刷新、分页和报告查询兼容性 |
| `tests/procurement.test.js` | 包装、价格、订单、库存、配送、结算等采购规则 |
| `tests/procurement-regression.test.js` | 微信环境中的真实模块和页面回归：账号切换、缓存隔离、验价、确认和提交重试 |

自动化测试使用模拟环境，并不替代 IIS、真实数据库、微信授权和真机联调。后台改动还需在配套环境编译 C#，验证数据库事务、权限与文件下载。

提交前检查差异：

```powershell
git diff --check
git diff --stat
```

## 后台部署

后台部署独立于小程序上传。必须先获取完整的 `background/` 配套交付物，不能仅凭本仓库前端文件搭建完整服务。

1. 备份现有站点和数据库，在测试环境核对现有 IIS、.NET、SQL Server 及 SWcms 依赖。
2. 检查 `background/Web.config` 的数据库连接及程序集配置，保留服务器已有环境配置，不直接覆盖凭据。
3. 核对 `background/migrations/001_procurement_tables.sql` 和 `App_Code/ProcurementDbMigrationScript.cs`。代码包含启动迁移检查；上线前仍需核对迁移权限、执行结果和数据库结构。
4. 按发布清单同步后台源码、页面、处理程序、运行程序集及导入模板到站点对应位置。
5. 在 `/swadmin/login.aspx` 登录后台，配置微信 AppID / AppSecret；配置目录 `xmlconfig/` 需具备后台保存配置所需的写权限。
6. 配置医院客户、采购用户准入、物料、可下单单位、价格、地址和批次库存，完成下单至结算全流程验证。

主要后台入口：

| 入口 | 用途 |
| --- | --- |
| `/swadmin/admins.aspx`、`settings.aspx` | 账号角色与小程序配置 |
| `/swadmin/hospitals.aspx` | 既有报告查询医院账号 |
| `/swadmin/customers.aspx`、`materials.aspx` | 采购客户准入与物料主档 |
| `/swadmin/prices.aspx` | 合同价格和赠品规则 |
| `/swadmin/orders.aspx`、`inventory.aspx`、`shipments.aspx` | 接单、库存和派送分配 |
| `/swadmin/delivery.aspx` | 配送员工作台 |
| `/swadmin/settlement.aspx` | 月度对账和导出 |

当前后台角色为 `admin`、`finance`、`logistics`、`delivery`。管理员可管理全部配置和账号，财务使用价格与对账功能，物流负责库存和派送，配送员使用配送工作台。现有代码还允许财务进入订单和派送页面；如需严格限制财务仅能定价和对账，需另行审核页面及操作权限。

自动收货使用后台定时巡检，并提供 `/tools/proc_cron.ashx` 补偿入口。IIS 回收或休眠会影响内存定时任务，应验证任务触发和补偿结果。自然月结算按北京时间业务口径计算，当前实现使用服务器本地时间，部署时需核对服务器时区。

前端报价确认依赖后台 `ProcurementApiHandler.cs` 和 `ProcurementOrder.cs` 的对应校验逻辑，发布时必须同步匹配的后端版本。

## 小程序发布

1. 运行自动化测试，检查代码差异及实际环境配置。
2. 确认后台版本、数据库结构、微信配置和合法域名已经就绪。
3. 在开发者工具检查上传文件列表：包含 `utils/config.js`、页面、导航图标、日历及其运行依赖；排除后台、开发依赖和本地资料。当前 `.ai/` 未在上传排除列表显式声明，本地存在该目录时需核对打包结果。
4. 上传体验版并真机验证：
   - 病理与 LIS 登录、日期选择、搜索筛选、分页、排序、报告查看和下载。
   - 微信登录、手机号绑定、申请审核、医院标识及跨账号切换。
   - 包装单位、合同价和赠品、购物车编辑、网络失败、价格变化、提交重试。
   - 分批配送、手动及自动收货、月度对账和 Excel 下载。
5. 完成验收后提交审核和发布。上传前端不会同步部署 ASP.NET 后台。

## 常见问题

| 问题 | 排查方式 |
| --- | --- |
| 找不到 `utils/config.js` | 从模板复制并填写本地配置；该文件不会随 Git 提交 |
| 编译成功但接口不可用 | 核对合法域名、HTTPS、API 地址、签名、后台状态和相应账号权限 |
| 耗材目录无法进入 | 检查微信登录、手机号、采购审核状态及关联医院；报告查询账号不能替代采购准入 |
| 购物车无法结算 | 先完成服务端验价；核对网络、物料准入、价格和数量限制 |
| 日历组件缺失 | 安装依赖后执行 `npm run prepare:calendar`，检查生成文件和引用 |
| 本地后台改动未出现在 Git 差异中 | `background/` 被忽略，需通过独立后台发布清单交付 |

## 贡献与提交约定

- 按现有架构做最小必要修改，保持病理、LIS 和采购的账号与接口边界。
- 提交贡献前应阅读项目许可证，确认有权提供相关代码，并保留第三方来源和许可声明。
- 功能、缺陷修复、文档和无关整理分别提交，避免夹带环境凭据或本地资料。
- 提交信息采用 Conventional Commits 形式：`type(scope): description`；正文说明必要的行为变化与验证，中文描述可保留。

例如：

```text
feat(procurement): 增加耗材采购功能
fix(procurement): 修复采购账号隔离与下单校验
docs(readme): 更新项目功能与开发部署说明
```

## 许可证

本仓库自主开发的软件代码采用 **PolyForm Noncommercial License 1.0.0**，SPDX 标识为 `PolyForm-Noncommercial-1.0.0`。完整英文条款见根目录 [`LICENSE`](LICENSE)，来源为 [PolyForm 官方版本文本](https://github.com/polyformproject/polyform-licenses/blob/1.0.0/PolyForm-Noncommercial-1.0.0.md)。以下中文说明是摘要，具体授权范围以许可证正文为准。

- **允许的用途**：非商业使用、修改和再分发，以及许可证列明的个人研究、学习、实验等用途。
- **机构使用**：许可证还明确允许慈善组织、教育机构、公共科研机构、公共安全或公共医疗卫生机构、环保组织及政府机构使用，不因其资金来源改变这项授权。不能仅以“是否收费”判断全部使用场景。
- **商业授权**：未被许可证允许的商业用途，需先向项目权利人另行取得授权；本仓库不提供默认商业许可。
- **再分发要求**：向接收方提供许可证文本或其官方链接，并保留权利人提供的 `Required Notice:` 声明及第三方许可声明。
- **许可性质**：这是附用途限制的源码可用许可，不是符合 [OSI 开源定义](https://opensource.org/osd) 的开源许可证。
- **适用边界**：本许可证不改变第三方代码的原有许可，也不授予品牌、商标、患者信息、客户数据、生产凭据或未随仓库交付的后台资料的使用权。

第三方日历组件许可见 [`components/tdesign/LICENSE`](components/tdesign/LICENSE) 和 [`components/tdesign/NOTICE.md`](components/tdesign/NOTICE.md)，再分发时应保留相应声明。商业授权需求可通过本仓库 Issue 或既有项目沟通渠道联系维护方，由相关权利人确认。
