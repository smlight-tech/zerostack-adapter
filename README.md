# @smlight/zerostack-adapter

[zigbee-herdsman](https://github.com/Koenkk/zigbee-herdsman) (`^11.2.0`) adapter for SMLIGHT ZeroStack coordinator firmware, backed by a prebuilt Rust Node-API addon.

## Install

Install alongside your host's `zigbee-herdsman`:

```sh
npm install @smlight/zerostack-adapter
```

- **Node.js:** `^22.2.0 || ^24 || <=26.2`
- **Prebuilt binaries:** `linux-x64-gnu`, `linux-arm64-gnu`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-arm64`, `darwin-x64`, `win32-x64-msvc` (override with `$ZEROSTACK_ADAPTER_ADDON`).

## Usage

### Register hook (Zigbee2MQTT / zigbee-herdsman)

Prefix your coordinator port with `zs:` and load the register hook before startup so `zs:` paths route to `ZsAdapter` while all other ports stay unchanged:

```yaml
serial:
  adapter: zstack
  port: zs:serial:/dev/ttyUSB0 # or zs:tcp://192.0.2.1:6638
```

```sh
NODE_OPTIONS="--import @smlight/zerostack-adapter/register" node index.js
```

For containerized Zigbee2MQTT, mount the package into `/app/node_modules/@smlight/zerostack-adapter` and set `NODE_OPTIONS="--import @smlight/zerostack-adapter/register"`.

### Native `adapter: "zerostack"` (proposed upstream)

Native optional `adapter: "zerostack"` support in `zigbee-herdsman` is proposed upstream and not yet merged. Once merged, set `adapter: "zerostack"` with a serial `/dev/...` / `COMn` path or `tcp://host:port` without `--import`; until then, use the register hook above or `createZeroStackAdapter` directly with `zigbee-herdsman ^11.2.0`.

## Building from source

Requires Node.js and the Rust toolchain declared in [rust-toolchain.toml](rust-toolchain.toml):

```sh
npm run build
```

## License

[MIT](LICENSE)

Prebuilt native addons link the unmodified `serialport` crate (`4.10.1`, [Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/), source at <https://github.com/serialport/serialport-rs>).
