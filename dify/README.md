# 赛博说书人 CyberStory · 600076 参赛作品

> 一句话玩法：你说一句今天发生的事，它去 **seekdb** 里翻出公司宇宙里的「角色 / 梗 / 道具」，
> 再让 **Dify** 的大模型用这些素材现编一段三十秒的微型说书。
> 回答末尾会附上「命中素材」，你能清楚看到这次回答到底用到了库里哪几条数据。

## 1. 作品创意

办公日常里最有生命力的东西是「梗」，但它们散在聊天记录里，谁也不会去整理。
这个应用把「公司宇宙」沉淀成四张表：**角色设定、梗库、道具库、历史回合**。
你输入一句模糊的场景（「机房又断网了」），它用全文检索把这句场景对应的
人、事、物捞出来，交给模型写一段有具体人名和道具的段子 —— 检索决定「像不像」，
模型决定「好不好笑」。

为什么需要检索而不是直接问模型：模型不知道你们公司有个「揣着一捆网线的铁柱」，
也不知道「Cookie 掉了」在这个语境里指的是什么。**这些只存在于 seekdb 里**，
所以每条回答都能被追溯：命中了哪几条、得分多少、第几回合写进了 `turns` 表。

## 2. Dify 与 seekdb 的分工

| 组件 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| Dify（社区版 1.19，docker compose 部署） | 编排、提示词、模型调用、对话体验、变量传递 | 不存业务数据 |
| seekdb（嵌入式引擎，或 2881 服务端） | 业务四张表、`FULLTEXT(ik)` 全文索引、`MATCH ... AGAINST` 检索、回合落库 | **不替换 Dify 的 PostgreSQL 元数据库** |
| FastAPI 后端（`backend/app.py`） | 把 HTTP 请求翻译成 seekdb 查询，拼提示词上下文，写 `turns` | 不做任何模型推理 |

链路：`开始 → HTTP Request(检索 seekdb) → 代码节点(解析 JSON) → LLM(deepseek-chat) → 直接回复`。
Dify 本体仍跑在自己的 PostgreSQL 上；seekdb 只作为**应用侧检索库**，两者互不干涉。

## 3. 目录结构

```
dify/
├── README.md                     # 本文件：玩法、分工、部署、限制
├── DSL/
│   └── CyberStory-600076.yml     # 从 Dify 1.19 导出的 Chatflow DSL（导入即用，模型已指定）
├── backend/
│   ├── app.py                    # FastAPI：/health /search /compose /turns /stats /debug
│   ├── seed.sql                  # 建表 + 40 条种子数据 + 4 个 FULLTEXT(ik) 索引
│   └── requirements.txt
├── verify/
│   └── 验证样例.md               # 复现步骤 + 预期 + 本次实测结果
├── deploy/
│   └── docker-compose.override.example.yaml   # 需要出网时的补充配置示例（占位）
└── evidence/
    ├── 01-seekdb-tables.png      # seekdb 里的表与行数
    ├── 02-search-api.png         # /search 真实命中 TOP3
    ├── 03-dify-app.png           # Dify 应用页（输入变量 query）
    ├── 04-dify-chat.png          # 端到端问答：回答 + 命中的 3 条素材
    ├── 05-dify-workflow.png      # 编排画布：5 个节点 + 已发布
    ├── 06-workflow-run.log       # 一次真实执行的 SSE 事件流（节点级日志）
    └── 07-seekdb-turns.json      # turns 表里由 Dify 写入的回合记录
```

## 4. 依赖版本

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Dify | 社区版 **1.19.0**（DSL 版本 0.3.1，导入后自动迁移到 0.7.0） | `docker compose`，`COMPOSE_PROFILES=pgvector,postgresql`，`VECTOR_STORE=pgvector`（与元数据库同源，少起一个容器） |
| seekdb | `pylibseekdb` 1.4.x（嵌入式，随包自带引擎）或 `oceanbase/seekdb` 镜像 | 二选一，代码同一套 SQL |
| Python | 3.12（`pylibseekdb` 的 3.12 wheel 自带引擎二进制，最稳） | 3.13 的 abi3 轮子在部分机器上初始化失败 |
| 后端依赖 | `fastapi`、`uvicorn`、`pymysql`、`pylibseekdb` | 见 `backend/requirements.txt` |
| 模型供应商 | 插件 `langgenius/openai_api_compatible:0.0.83` + DeepSeek | 1.19 里模型供应商是插件，需从插件市场安装一次 |

## 5. 部署步骤

### 5.1 起 Dify（社区版 1.19）

```bash
git clone https://github.com/langgenius/dify.git && cd dify/docker
cp .env.example .env
# 端口改成不冲突的 8080
sed -i 's/^EXPOSE_NGINX_PORT=.*/EXPOSE_NGINX_PORT=8080/' .env
# 用 pgvector 当向量库（与元数据库同源，省一个容器）
sed -i 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=pgvector,postgresql/' .env
echo 'VECTOR_STORE=pgvector' >> .env
docker compose up -d
docker compose ps          # 等 api / worker / db_postgres / pgvector / redis / nginx 全部 healthy
```

浏览器打开 `http://<本机IP>:8080`，用邮箱 + 密码完成管理员初始化（首个账号即管理员）。
本次实测账号：`admin@cyberstory.local`（密码为本地演示值，未提交到仓库）。

**安装模型供应商插件**（1.19 把供应商拆成插件，空白环境里列表是空的）：

设置 → 模型供应商 → 搜索 `OpenAI-API-compatible` → 安装，
然后新建一个自定义模型：

| 字段 | 填写 |
| --- | --- |
| Model Name | `deepseek-chat` |
| Base URL (endpoint_url) | `https://api.deepseek.com/v1`（换成你自己的兼容端点） |
| API Key | `<YOUR_API_KEY>`（占位，仓库不提交真实值） |
| Mode | `chat` |
| Context Size | `65536` |

> 插件安装、以及后续调用模型时，容器需要能访问 `marketplace.dify.ai` 与模型 API。
> 本次在桌面版上通过 `docker-compose.override.yaml` 给 `api / worker / worker_beat / plugin_daemon`
> 注入宿主机 HTTP 代理实现，**不修改** Dify 自带的 compose。见 §7。

### 5.2 起检索后端 + 业务库

方式 A：嵌入式 seekdb（推荐，无需额外容器）

```bash
cd dify/backend
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python app.py                       # 监听 0.0.0.0:8181，首次启动自动建库 + 灌 40 条种子
```

方式 B：seekdb 服务端 + 同一个后端

```bash
docker run -d --name seekdb -p 2881:2881 oceanbase/seekdb:latest
cd dify/backend && SEEKDB_HOST=127.0.0.1 SEEKDB_PORT=2881 python app.py
```

自检（都应有返回）：

```bash
curl -s http://127.0.0.1:8181/health
# {"ok":true,"engine":"seekdb","mode":"embedded","version":"5.7.25-OceanBase seekdb-v1.4.0.0","parser":"ik",
#  "tables":{"personas":12,"memes":18,"props":10,"turns":N}}

curl -s "http://127.0.0.1:8181/compose?q=机房又断网了&session_id=demo"
```

> Dify 跑在容器里时，HTTP 节点访问宿主机后端要用 `http://host.docker.internal:8181`（macOS/Windows）。
> Linux 上需要给 api/worker 加 `extra_hosts: ["host.docker.internal:host-gateway"]`。
> 若 Dify 配了 `SSRF_PROXY_*`，squid 会拦掉私网地址，需要把这三个变量置空让 HTTP 节点直连。

### 5.3 导入 DSL

1. Dify 控制台 →「导入 DSL 文件」→ 选 `DSL/CyberStory-600076.yml`；
2. 导入后进入「编排」，确认 **LLM 节点**已选中 `deepseek-chat`（DSL 里已写死供应商与原模型名）；
3. 确认 **HTTP Request 节点**地址为 `http://host.docker.internal:8181/compose`；
4. 右上角「发布」，用「访问入口」里的链接对话。

导入只有一步（单文件 DSL），不需要先建知识库或工具。

## 6. 入口地址

| 服务 | 地址 |
| --- | --- |
| Dify 应用（对话入口） | `http://<本机IP>:8080/chat/R17ulPtweqdsA9v8`（token 以你自己发布后为准） |
| Dify 编排画布 | `http://<本机IP>:8080/app/<APP_ID>/workflow` |
| 检索后端 | `http://<本机IP>:8181/health`（另有 `/debug` 可视化证据页） |
| seekdb | 嵌入式：`dify/backend/data/seekdb`；服务端：`127.0.0.1:2881` |

## 7. 本机部署时踩到的三个坑（可复现的说明）

1. **镜像拉取**：Docker Hub 在国内直连不通，桌面版 daemon 的 go proxy 还会把流量绕到
   `hubproxy.docker.internal`，实测只有 40~80 KB/s。最终用「宿主机 curl 下载层 + 组装
   docker-archive + `docker load`」的方式（走本地代理，8.6 MB/s）把 10 个镜像一次拉齐。
2. **目录共享授权**：`docker compose up` 时 Docker Desktop 会为每个 bind mount 弹
   「Docker wants to access ...」，无人点 Yes 时会自动拒绝并报
   `user declined directory sharing`，逐个点允许即可。
3. **插件市场/模型 API 出网**：用一份 `docker-compose.override.yaml` 只给需要出网的四个服务
   注入代理，`NO_PROXY` 保留全部内部服务名，避免内部调用被代理劫持。
   可直接参考 `deploy/docker-compose.override.example.yaml`（把 `<HOST_PROXY>` 换成你的代理地址）。

## 8. 已知限制

- 语料是 40 条硬编码种子数据，没有接入真实聊天记录；换业务只需改 `seed.sql`。
- 检索是关键词全文检索（ik 分词 + `MATCH ... AGAINST`），不做向量召回；
  同义表述（「熬夜」vs「凌晨」）命中率有限，命中 0 条时回答会明显变「瞎编」。
- ik 分词器缺失时会退化为默认分词器（`/health` 的 `parser` 字段显示 `default`），链路仍通但召回变差。
- LLM 依赖真实可用的 API Key，仓库里只出现占位值。
- 单机部署，未做鉴权限流；`/seed?force=true` 会清表重灌，仅供演示。

## 9. 安全说明

仓库内所有凭据都是占位值：模型 Key、数据库密码一律写成 `<YOUR_API_KEY>` / `<YOUR_DB_PASSWORD>`。
`backend/data/`（嵌入式引擎数据目录）、`docker-compose.override.yaml` 里的代理地址均为本机环境相关，
不包含任何真实密钥。
