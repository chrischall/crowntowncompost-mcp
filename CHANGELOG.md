# Changelog

## [0.5.0](https://github.com/chrischall/crowntowncompost-mcp/compare/v0.4.0...v0.5.0) (2026-09-04)


### Features

* **tools:** compact by default — strip media URLs, and minify every response ([#44](https://github.com/chrischall/crowntowncompost-mcp/issues/44)) ([59bbd17](https://github.com/chrischall/crowntowncompost-mcp/commit/59bbd17e50c8698e34cfb72830b282e50ff43286))


### Bug Fixes

* **build:** restore the literal em dash in the package description ([#47](https://github.com/chrischall/crowntowncompost-mcp/issues/47)) ([c97daa8](https://github.com/chrischall/crowntowncompost-mcp/commit/c97daa888eddb5f0ee8c4f5cde515875bc83d7be))
* **deps:** pick up @chrischall/mcp-utils 0.23.2 ([#49](https://github.com/chrischall/crowntowncompost-mcp/issues/49)) ([03b9959](https://github.com/chrischall/crowntowncompost-mcp/commit/03b99591ef072bffb6371efdeb615c35847cae8f))

## [0.4.0](https://github.com/chrischall/crowntowncompost-mcp/compare/v0.3.1...v0.4.0) (2026-08-28)


### Features

* **auth:** accept a supplied session cookie via CROWNTOWN_SESSION_COOKIE ([#24](https://github.com/chrischall/crowntowncompost-mcp/issues/24)) ([e45b5f2](https://github.com/chrischall/crowntowncompost-mcp/commit/e45b5f28670d8c4397ea6efe602279c30ff6a47a))
* cache the signed-in portal session so a restart skips the login ([#28](https://github.com/chrischall/crowntowncompost-mcp/issues/28)) ([daa5e22](https://github.com/chrischall/crowntowncompost-mcp/commit/daa5e229f6626c6aae429736b1341ac7db76f544))


### Documentation

* list the cache env vars in server.json and .env.example ([#30](https://github.com/chrischall/crowntowncompost-mcp/issues/30)) ([3d04bd0](https://github.com/chrischall/crowntowncompost-mcp/commit/3d04bd0e6e408609afc3cfb62e8e26b96389b4cd))

## [0.3.1](https://github.com/chrischall/crowntowncompost-mcp/compare/v0.3.0...v0.3.1) (2026-08-07)


### Refactor

* **connector:** retire the standalone Cloudflare Worker connector ([#9](https://github.com/chrischall/crowntowncompost-mcp/issues/9)) ([b386958](https://github.com/chrischall/crowntowncompost-mcp/commit/b3869584a771d89d2e1fb2a8188635f525e68fee))


### Documentation

* state the fetch-binding rule without naming wrangler ([#14](https://github.com/chrischall/crowntowncompost-mcp/issues/14)) ([5926f3d](https://github.com/chrischall/crowntowncompost-mcp/commit/5926f3d84726b6bb9929a302ad11ba61f587a4f1))

## [0.3.0](https://github.com/chrischall/crowntowncompost-mcp/compare/v0.2.0...v0.3.0) (2026-07-31)


### Features

* add crowntown_get_pickup_schedule tool (days + observed time window) ([#7](https://github.com/chrischall/crowntowncompost-mcp/issues/7)) ([fedc773](https://github.com/chrischall/crowntowncompost-mcp/commit/fedc773fba7f0478be2c17f6bb284eedc75fd0b2))


### Documentation

* record skip-service as live-verified ([#5](https://github.com/chrischall/crowntowncompost-mcp/issues/5)) ([03d09c5](https://github.com/chrischall/crowntowncompost-mcp/commit/03d09c50f59445aa80ea8674b960f10cab45ca41))

## [0.2.0](https://github.com/chrischall/crowntowncompost-mcp/compare/v0.1.0...v0.2.0) (2026-07-31)


### Features

* hosted Cloudflare connector for claude.ai access ([#2](https://github.com/chrischall/crowntowncompost-mcp/issues/2)) ([d7f8bf3](https://github.com/chrischall/crowntowncompost-mcp/commit/d7f8bf39c515e58599418d0be28f285906f6bdb1))

## 0.1.0 (2026-07-31)


### Features

* Crown Town Compost customer-portal MCP server ([6d543f8](https://github.com/chrischall/crowntowncompost-mcp/commit/6d543f8bdfa0915d0d02fdde475701f165368512))
