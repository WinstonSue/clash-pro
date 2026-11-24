# Clash Pro

基于 Tauri v2 的 Clash Verge macOS 菜单栏扩展。Agent 和日常各自维护有序供应商名单，两组共用地区。也可在 Tailscale 上使用本机共享代理，或让另一台 Mac 成为自己的跳板。

## 安装

需要 Apple Silicon、macOS 13 或更新版本、Clash Verge，以及 Node.js 22.12 或更新版本。建议通过 Homebrew 或 Node.js 官方安装器安装 Node.js，让菜单栏应用能在 `/opt/homebrew/bin/node` 或 `/usr/local/bin/node` 找到它。

在 [GitHub Actions](https://github.com/WinstonSue/clash-pro/actions/workflows/ci.yml) 打开一次成功构建，从 Artifacts 下载 macOS arm64 ZIP。解压后将 `Clash Pro.app` 移到「应用程序」。CI 包使用 ad-hoc 签名，未经 Apple 公证。也可以从源码构建后打开 `build/Clash Pro.app`。

## 本机供应商

1. 打开 Clash Pro，新增供应商并为其导入临时 HTTPS 订阅。导入支持 Clash YAML 内联的 Shadowsocks、AnyTLS、Trojan、VMess 和 VLESS 节点。程序只保存清洗后的节点。
2. 为 Agent 和日常分别选择并排序供应商。选一个共同地区，再按需设置额外心跳地区。
3. 首次使用时，在 Clash Verge 导入并启用「复制 Clash 配置链接」取得的配置。增删供应商、调整顺序或切换模式后刷新该订阅。重导节点、改名和地区切换通过已连接的内核同步。

升级会沿用原配置链接、节点、选区和提醒历史，并在数据目录保存 `state-v1.backup.json`。回滚旧应用前，退出新版并把此文件恢复为 `state.json`。

## Tailscale 跳板

1. 两台 Mac 都安装 Clash Pro 和 Clash Verge，并加入同一 Tailscale 网络。
2. 出口机设置供应商线路，在「Tailscale 跳板」查找设备，授权目标机并复制对应配对码。共享默认使用本机的 Tailscale IPv4 及 `17882` TCP、UDP。配对码包含设备专用密钥，应只交给授权的目标机。
3. 目标机在「通过跳板上网」粘贴配对码，选择「验证并启用」，然后导入或刷新本机的 Clash Pro 订阅。用系统代理可访问普通网页。需要代理普通应用的 UDP 时，在目标机 Clash Verge 中开启 TUN。
4. 目标机以应用内置规则选择直连或跳板。从跳板到网站的线路由出口机决定。Agent 域名走 Agent，其余公网流量走日常。UDP 根据线路顺序选择支持 UDP 的节点。撤销设备、关闭共享或更换密钥会断开受影响的连接。

跳板使用独立的 Mihomo 内核和加密监听，控制接口和订阅继续通过本机回环提供。

## 分流和告警

- 内网、国内域名及未命中代理白名单的请求走直连。日常含常用网站、影音、社交和 GFW 域名。已知系统更新、软件包、镜像和 GitHub 发布下载端点默认直连。通过 `aria2c` 或本机 `127.0.0.1:17881` 下载入口发起的境外请求使用日常。
- 开源规则由内置的 [MetaCubeX 数据快照](https://github.com/MetaCubeX/meta-rules-dat/tree/13c258bce343dfc81d5600e535a59588386ef4b9/geo) 提供。可在本机供应商模式通过数据目录下的 `personal-direct.json` 添加直连规则，文件为 Mihomo 直连规则的 JSON 字符串数组。修改后重新打开应用并刷新订阅。
- 心跳默认每 10 分钟检查当前地区，每 30 分钟检查额外地区。连续两轮只剩一个可用端点会告警，连续两轮为零会发全断通知。节点和历史记录存放在用户私有的 `~/Library/Application Support/Clash Pro`。

## 开发验证

安装 Rust stable（1.90 或更新版本）和 Xcode 命令行工具，确保 Rust 已安装 `aarch64-apple-darwin` 目标，然后运行下面的命令。构建先准备 Rust 测试需要的应用资源。

```sh
npm ci
npm test
npm run build:app
cargo test --manifest-path src-tauri/Cargo.toml --locked --release --target aarch64-apple-darwin
```

用 `npm start` 启动独立本机服务，测试可用 `CLASH_PRO_DATA_DIR` 指向临时目录。macOS 通知取决于系统授权，应用内会保留同一份提醒记录。

## 许可证

Clash Pro 源码采用 [GPL-3.0-only](LICENSE)。内置规则保留 MetaCubeX 的 GPLv3 许可证。规则来自固定的上游版本，应用构建使用已校验的离线 MRS 文件。[规则来源与转换方法](rules-data/README.md)
