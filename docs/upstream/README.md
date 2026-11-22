# Upstream integration

Native optional `zerostack` adapter integration in `zigbee-herdsman` (`adapter: "zerostack"`,
calling `createZeroStackAdapter(Adapter, ...)`) is proposed upstream and not yet merged. Until
upstream merges it, use the `@smlight/zerostack-adapter/register` hook or call
`createZeroStackAdapter` directly with `zigbee-herdsman ^11.2.0`.

- `zigbee2mqtt-external-adapter.diff`, against the Zigbee2MQTT `dev` branch (`lib/types/api.ts`,
  `lib/util/settings.schema.json`): allows external/custom `serial.adapter` specifiers alongside the
  built-in adapter names when routing through an external adapter hook or package specifier.

## Patch licensing

Each upstream patch in this directory applies to and is offered under the target project's own
licence: **MIT** for `zigbee-herdsman` patches and **GPL-3.0** for `zigbee2mqtt` patches.

`test/pluggable-adapter.mjs` tests the generic external-adapter loading path in JavaScript.
