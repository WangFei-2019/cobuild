# GitHub 入口发布与正式协作服务部署

正式协作使用 Node.js 24 与持久存储运行后端。独立仓库 WangFei-2019/cobuild 的 GitHub Pages 首页改为工作区连接入口，用户确认服务地址后前往该服务器登录。原演示独立保留在 `demo.html`，沿用浏览器中已有的示例与改动，无真实账号、多人同步、服务端 AI 或密钥。GitHub Pages 仅提供静态 HTML/CSS/JavaScript，不能运行原来的 Node 后端。[GitHub Pages 官方说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

## Pages 工作区入口与独立演示

先按下节生成独立发布目录并将其内容作为仓库根，不能推送工作区父目录。公开仓库可使用 GitHub Free 的 Pages；私有仓库可用性依账号方案，仓库所有者需核对。

在 GitHub 仓库打开 **Settings → Pages → Build and deployment → Source，选择 GitHub Actions**。这一步需先完成；configure-pages 仅读取已开启的站点配置，工作流不会自动开启 Pages。若此步失败，日志会输出同样的可操作指引；完成设置后在 Actions 重新运行 Deploy CoBuild entry。

pages.yml 在 main push 或手动触发后进行冻结安装、全量测试、独立静态构建，仅上传 dist-pages，并由 github-pages 环境部署。构建与部署分 job，部署 job 只获 pages:write 和 id-token:write；不需要保存 AI key、服务器口令或个人 token。预期项目站点为 https://wangfei-2019.github.io/cobuild/ ，实际是否已上线以成功的 deployment URL 为准。

本地构建命令为 pnpm install --frozen-lockfile 后运行 pnpm build:pages。`index.html` 使用独立 `entry.js/entry.css`，不加载演示适配器；`demo.html` 使用 `app.js/app.css` 和 hash 路由，适配 /cobuild/ 子路径与页面刷新。资源 URL 带实际内容摘要，避免发布后混用旧资源。

仓库 Settings → Secrets and variables → Actions → Variables 可配置公开变量 `COBUILD_SERVICE_URL`，值为正式服务 HTTPS 根地址（支持 IP 和自定义端口）。本仓库 Pages 工作流预置当前已部署的 `https://123.57.227.212:5175`，公开变量可覆盖此地址；本地构建未指定该变量时由使用者输入，不声称已部署。该地址可保存在本机浏览器。入口不会跨域调用账号 API 或传送项目资料，而是直接导航到所选服务，登录会话留在服务自身的站点。不要将初始化口令、模型密钥或带邀请令牌的 URL 填入此变量。构建会拒绝缺失演示适配器/种子数据、包含服务器身份数据库模块的产物，不会把 public 目录直接当作 Pages 版本发布。

浏览器 SHA-256 适配使用精确锁定的 @noble/hashes 2.4.0，同步保持里程碑指纹与重规划 ID 语义；随机 ID 使用浏览器安全随机数。它只供 Pages 构建，正式后端仍用 node:crypto。静态产物保留第三方许可。[Pages 自定义 Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[noble-hashes 官方用法](https://github.com/paulmillr/noble-hashes#usage)

## 1. 先生成独立仓库内容

当前工作区包含其他项目。**不要在工作区父目录执行整仓发布；发布包中 package.json、server.mjs 和 .github 必须成为新仓库的根目录内容。** 仓库名、公开/私有及运行平台由所有者选择，本脚本不会创建仓库、推送或部署。

在本项目目录运行，输出路径须为尚不存在、位于源码目录之外的目录：

```sh
pnpm install --frozen-lockfile
node --test tests/*.test.mjs
node scripts/build.mjs
node scripts/package-release.mjs --out /tmp/cobuild-release --archive /tmp/cobuild-release.tar.gz
node scripts/verify-release.mjs /tmp/cobuild-release
```

脚本按白名单取根目录后端模块、前端源码与构建资源、测试、必要脚本、工作流和发布文档。它不遍历 .local、.secrets、node_modules、screenshots、父目录项目，也不复制 .env。遇到发布文件符号链接、常见凭据格式、目标已存在或缺少必要文件会停止。RELEASE-MANIFEST.json 记录每个文件的 SHA-256 和大小；校验会拒绝内容变化及额外文件。这是完整性检查和泄露防护，不能替代对即将公开内容的人工审阅。

解压归档时先创建新空目录，将其中内容直接作为仓库根；Actions 下载的 artifact 也包含同样的根目录内容。初次提交示例（替换 OWNER/REPOSITORY，先在 GitHub 创建选定可见性的空仓库）：

```sh
cd /tmp/cobuild-release
node scripts/verify-release.mjs .
git init -b main
git add .
git diff --cached --stat
git commit -m "Release CoBuild"
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

请在初始化 Git 前完成发布清单校验；.git 目录不是发布文件。生成的 RELEASE-MANIFEST.json 已被 .gitignore 排除，CI 会为每次新发布重新生成清单。后续开发应在这个独立仓库中进行，避免反复从父工作区整仓复制。

## 2. 已提供的 Actions

根目录 .github/workflows/ci.yml 在 push、pull_request 和手动触发时执行：

1. Node.js 24、固定 pnpm 11.25.0 与冻结锁文件安装。
2. 全量领域及真实鉴权 HTTP 测试；模型测试使用本机 fixture。
3. 生产前端构建、只读 doctor 预检、独立发布包校验。
4. 上传保留 14 天的发布 artifact；另一个 job 从源码构建 Docker 镜像并检查真实容器健康接口。

publish-image.yml 为完整服务的可选发布：默认仅手动触发；若希望 v* 标签自动发布，先在仓库 Settings → Secrets and variables → Actions → Variables 添加 COBUILD_PUBLISH_GHCR=true。它重新测试、构建、打包，启动容器检查后发布 ghcr.io/owner/repository:sha-完整提交哈希。版本标签还必须与 package.json.version 一致，才会增加对应的 v版本 镜像标签；没有浮动 latest。工作流摘要打印镜像 digest，生产环境应固定该 digest。

```sh
git tag v0.2.0
git push origin v0.2.0
```

工作流使用完整提交 SHA 固定官方 checkout、setup-node、upload-artifact；CI 仅 contents:read，镜像发布另有 packages:write。发布 GHCR 使用 Actions 自动提供的 GITHUB_TOKEN，无需提供个人发布 token，也不需要 AI 密钥。镜像构建没有密钥 build arg。运行机器拉取私有包时另需有 read:packages 权限的凭据，公开包可匿名拉取；仓库可见性与包权限应分别核对。[GitHub 镜像发布](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)、[GHCR 认证与 digest](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)、[Actions 安全用法](https://docs.github.com/en/actions/reference/security/secure-use)

当前 ubuntu-latest 原生构建发布的是 Linux amd64 镜像，尚未配置 arm64 多架构发布。工作流会在 GitHub 执行时验证 Docker；本机没有 Docker 时，不能把 YAML 和脚本检查描述成已完成容器运行验证。

## 3. HTTPS 服务器部署

Dockerfile 为自包含多阶段构建：从锁文件安装并构建前端，运行阶段只复制后端原生模块、构建资源和启动脚本，以非 root 用户运行。它不依赖本机已有 public/app.js、node_modules 或数据库；.dockerignore 只允许所需构建输入进入上下文。[Docker 构建上下文](https://docs.docker.com/build/concepts/context/#dockerignore-files)

首次部署先按 [部署与配置](./部署与配置.md) 准备域名、HTTPS public origin 和服务器私有 .secrets 文件。初始化口令与 AI key 只放运行服务器的私有文件或进程环境，绝不提交 GitHub；空 AI key 可运行手动协作。先备份已有数据，保持单写入实例。

镜像部署使用独立的 compose.registry.yaml，**不要与 compose.yaml 叠加**。将该文件、Caddyfile、.env.example 复制到固定部署目录；两种 compose 的项目名必须一致，数据卷才保持一致。以下使用固定项目名 cobuild：

```sh
cp .env.example .env
# 在 .env 填写域名、HTTPS origin、模型名称等非敏感配置。
# COBUILD_IMAGE 填工作流摘要中的 ghcr.io/owner/repository@sha256:实际digest。
docker compose --project-name cobuild --file compose.registry.yaml config --quiet
docker compose --project-name cobuild --file compose.registry.yaml pull
docker compose --project-name cobuild --file compose.registry.yaml up --detach
docker compose --project-name cobuild --file compose.registry.yaml ps
```

配置 COBUILD_IMAGE 时删掉示例行的 #。如需从源码现场构建，则在独立仓库根运行 docker compose --project-name cobuild --file compose.yaml up --build --detach。不要同时以不同项目名启动两个实例。app 4173 只在容器网络暴露，Caddy 负责公开 80/443 与证书，命名卷 cobuild_data 保存 /app/.local 下 SQLite、JSON 和文件，Caddy 的证书目录也持久化。

更新时先做包含 SQLite 及上传文件的完整备份，再将 COBUILD_IMAGE 改为新 digest，pull 后 up --detach；不执行 down --volumes。回退需同时判断新版本是否改变数据格式；镜像回退不代表数据库自动回退。当前不承诺零停机、多实例、自动迁移或无人值守生产部署。线上第一次验收仍需验证 DNS/TLS、初始化登录、邀请加入、两台设备交接、重启持久化、备份恢复和真实模型配置。

## 4. Render 作为备选

Render 可从本仓库 Dockerfile 构建完整服务，但要在选定平台后再创建实例。必须配置单实例付费 persistent disk，并把 COBUILD_DATA_DIR 指向挂盘目录（如 /app/.local），在平台私有环境或 Secret File 配置初始化口令与模型 key，PUBLIC_URL 设为最终 HTTPS 站点。Docker 默认监听 0.0.0.0:4173；启动器按 --port、COBUILD_PORT、PORT、4173 的顺序选端口。Compose 内部端口固定 4173。

Render 默认文件系统临时，只有挂盘路径在部署与重启后保留；挂盘服务只能单实例，更新会有短暂中断。不能把“GitHub 自动构建”当成“数据已经持久化”。本版未创建 Render 项目，也未提供未经验证的一键 Blueprint。[Render Docker](https://render.com/docs/docker)、[Render 持久磁盘与限制](https://render.com/docs/disks)
