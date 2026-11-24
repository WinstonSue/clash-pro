# 内置分流规则

本目录的 25 个 MRS 文件来自 [MetaCubeX/meta-rules-dat 固定版本](https://github.com/MetaCubeX/meta-rules-dat/tree/13c258bce343dfc81d5600e535a59588386ef4b9/geo)，遵循 [MetaCubeX 的 GPLv3 许可证](LICENSE)。文件的 SHA-256 和规则类型记在 `manifest.json` 中。

仓库的 `rules-source/` 保存同一提交中对应的文本规则。源文本的文件名与 MRS 一一对应。上游域名规则位于 `geo/geosite/`，IP 规则位于 `geo/geoip/`，其中 `domain-steam-cn.list` 对应上游的 `steam@cn.list`。完整源码随每次 CI 构建提供，也可从 [Clash Pro 仓库](https://github.com/WinstonSue/clash-pro) 获取。

在仓库根目录使用 Mihomo `v1.19.33` 可复现这 25 个 MRS 文件。域名规则使用 `domain`，IP 规则使用 `ipcidr`。[Mihomo 转换文档](https://wiki.metacubex.one/en/config/rule-providers/#format)

```sh
mkdir -p build
mihomo convert-ruleset domain text rules-source/domain-google.list build/domain-google.mrs
mihomo convert-ruleset ipcidr text rules-source/ip-telegram.list build/ip-telegram.mrs
```

应用构建使用本目录中固定的 MRS 文件，并按清单校验哈希。
