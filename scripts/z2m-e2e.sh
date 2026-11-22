#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 SMLIGHT
# Zigbee2MQTT end-to-end check of a packed @smlight/zerostack-adapter against an external ZeroStack
# coordinator peer, in containers on the host network.
#
#   sh scripts/z2m-e2e.sh <package.tgz> <peer command...>
#
# <package.tgz>   `npm pack` output holding the zerostack_adapter.linux-x64-musl.node prebuild.
# <peer command>  runs the peer as `<peer command> <config.json>`; the config and its audit file are
#                 under ZS_E2E_TMPDIR, which a containerised peer must mount at the same path.
#
# Environment:
#   ZS_E2E_GATEWAY_IMAGE  gateway image (default koenkk/zigbee2mqtt:latest-dev)
#   ZS_E2E_BROKER_IMAGE   MQTT broker image (default eclipse-mosquitto:2)
#   ZS_E2E_MQTT_PORT      broker port on 127.0.0.1 (default 18830)
#   ZS_E2E_TMPDIR         parent of the run directory (default ${TMPDIR:-/tmp})
#   ZS_E2E_TIMEOUT        seconds per check, start and exit wait (default 120)
#   ZS_E2E_LOGS           if set, an existing directory that gets each scenario's gateway logs and
#                         peer audit before the run directory is removed
#
# Scenario 1 loads the package through its register hook (NODE_OPTIONS --import dist/hook.js) from
# a directory outside the gateway's node_modules, with `zs:tcp://` in serial.port. Scenario 2 boots
# without the hook, with serial.adapter naming the package's dist/index.js, after applying
# test/e2e/external-adapter-compiled.diff: the compiled-JavaScript equivalent of the proposed
# upstream change in docs/upstream/ (not the TypeScript diff itself), patched into a throwaway
# container at start. Two negative controls show that the same configuration fails without it.
set -eu

if [ "$#" -lt 2 ]; then
    echo "usage: $0 <package.tgz> <peer command...>" >&2
    exit 2
fi
package=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
shift
e2e=$(cd "$(dirname "$0")/../test/e2e" && pwd)
gateway_image=${ZS_E2E_GATEWAY_IMAGE:-koenkk/zigbee2mqtt:latest-dev}
broker_image=${ZS_E2E_BROKER_IMAGE:-eclipse-mosquitto:2}
mqtt_port=${ZS_E2E_MQTT_PORT:-18830}
timeout_s=${ZS_E2E_TIMEOUT:-120}
parent=${ZS_E2E_TMPDIR:-${TMPDIR:-/tmp}}
logs=${ZS_E2E_LOGS:-}

for tool in docker tar timeout mkfifo; do
    command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done
[ -f "$package" ] || { echo "no package at $package" >&2; exit 2; }
[ -z "$logs" ] || [ -d "$logs" ] || { echo "ZS_E2E_LOGS: no directory $logs" >&2; exit 2; }

work=$(mktemp -d "$parent/zerostack-adapter-e2e.XXXXXX")
current=$work
run=$(basename "$work" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-')
peer_pid=""

# Container-written files are root-owned: hand them back before removing the run directory.
cleanup() {
    status=$?
    trap - EXIT INT TERM
    stop_peer || status=1
    if docker inspect "$run-gateway" >/dev/null 2>&1; then
        save_log "$current" gateway.log || status=1
    fi
    if [ -n "$logs" ]; then
        for file in "$work"/*/*.log "$work"/*/peer-audit.jsonl; do
            [ ! -f "$file" ] || cp "$file" "$logs/$(basename "$(dirname "$file")")-$(basename "$file")" || status=1
        done
    fi
    ids=$(docker ps -aq --filter "label=zerostack-adapter-e2e=$run")
    if [ -n "$ids" ]; then
        # shellcheck disable=SC2086
        docker rm -f $ids >/dev/null || status=1
    fi
    docker run --rm --network none -v "$work:/run-dir" --entrypoint chown "$broker_image" -R "$(id -u):$(id -g)" /run-dir || status=1
    rm -rf "$work" || status=1
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The gateway's console log without colour codes, as $1/$2.
save_log() {
    docker logs "$run-gateway" 2>&1 | sed "s/$(printf '\033')\[[0-9;]*m//g" >"$1/$2"
}

fail() {
    echo "FAIL $*" >&2
    exit 1
}

# 802.15.4 network of every scenario, and the peer's factory and router addresses.
coordinator_ieee=00124b00e2e0c0de
router_ieee=0x00124b0000000001
router_nwk=4660
channel=15
pan_id=6754
ext_pan_id=0xdd11223344556677
ext_pan_yaml="[0xdd, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]"
network_key_yaml="[0x31, 0x7c, 0x05, 0xe2, 0x9a, 0x44, 0x10, 0xbd, 0x6f, 0x23, 0x88, 0xc1, 0x5e, 0x07, 0xd4, 0x9b]"
data=/config/zigbee2mqtt
herdsman_dir=$data/zerostack-adapter

# Starts the peer on a fresh store; sets peer_port. Its stdin stays open on fd 7 until stop_peer.
start_peer() {
    dir=$1
    shift
    cat >"$dir/peer.json" <<EOF
{"zerostack": true, "ieee": "$coordinator_ieee", "nv": null, "router": true, "routerOnNetwork": false,
 "touchlink": true, "powerCycleOnConnect": true, "audit": "$dir/peer-audit.jsonl"}
EOF
    : >"$dir/peer-audit.jsonl"
    mkfifo "$dir/peer.in" "$dir/peer.out"
    "$@" "$dir/peer.json" <"$dir/peer.in" >"$dir/peer.out" 2>"$dir/peer.err" &
    peer_pid=$!
    exec 7>"$dir/peer.in" 8<"$dir/peer.out"
    line=$(timeout "$timeout_s" sh -c 'IFS= read -r line && printf "%s\n" "$line"' <&8) ||
        fail "peer: no address line within ${timeout_s}s ($(cat "$dir/peer.err"))"
    peer_port=${line##*:}
    case $line in
        "listening 127.0.0.1:"*) ;;
        *) fail "peer printed '$line' instead of its address" ;;
    esac
    echo "peer listening on 127.0.0.1:$peer_port"
}

# Closes the peer's stdin; it must then exit 0 (it fails on frames it could not parse).
stop_peer() {
    [ -n "$peer_pid" ] || return 0
    exec 7>&- 8<&-
    pid=$peer_pid
    peer_pid=""
    if wait "$pid"; then
        return 0
    fi
    echo "FAIL peer exited non-zero: $(cat "$work"/*/peer.err 2>/dev/null)" >&2
    return 1
}

start_broker() {
    dir=$1
    printf 'listener %s 127.0.0.1\nallow_anonymous true\npersistence false\n' "$mqtt_port" >"$dir/mosquitto.conf"
    docker run -d --name "$run-broker" --label "zerostack-adapter-e2e=$run" --network host \
        -v "$dir/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" "$broker_image" >/dev/null
    # The gateway gives up if the broker is not listening yet: poll its log, bounded.
    end=$(($(date +%s) + timeout_s))
    until docker logs "$run-broker" 2>&1 | grep -q " running$"; do
        [ "$(docker inspect -f '{{.State.Running}}' "$run-broker")" = true ] ||
            fail "broker exited: $(docker logs "$run-broker" 2>&1 | tail -n 5)"
        [ "$(date +%s)" -lt "$end" ] || fail "broker not running within ${timeout_s}s"
        sleep 1
    done
}

stop_scenario() {
    docker rm -f "$run-gateway" "$run-broker" >/dev/null
    stop_peer || exit 1
}

# configuration.yaml for serial port $2 and adapter $3 in data directory $1.
write_config() {
    cat >"$1/configuration.yaml" <<EOF
version: 5
mqtt:
  base_topic: zigbee2mqtt
  server: mqtt://127.0.0.1:$mqtt_port
serial:
  port: $2
  adapter: $3
advanced:
  network_key: $network_key_yaml
  pan_id: $pan_id
  ext_pan_id: $ext_pan_yaml
  channel: $channel
  log_level: debug
  log_output: [console]
frontend:
  enabled: false
homeassistant:
  enabled: false
EOF
}

# A data directory with the package unpacked outside the gateway's node_modules.
make_data() {
    dir=$work/$1
    mkdir -p "$dir/data/zerostack-adapter"
    tar -xzf "$package" -C "$dir/data/zerostack-adapter" --strip-components=1
    [ -f "$dir/data/zerostack-adapter/zerostack_adapter.linux-x64-musl.node" ] ||
        fail "$package holds no zerostack_adapter.linux-x64-musl.node"
    [ -f "$dir/data/zerostack-adapter/dist/hook.js" ] || fail "$package holds no dist/hook.js"
    echo "$dir"
}

# Runs the gateway in the background: data directory $1, then extra `docker run` arguments, `--`,
# and the command.
start_gateway() {
    dir=$1
    shift
    docker run -d --name "$run-gateway" --label "zerostack-adapter-e2e=$run" --network host \
        -e ZIGBEE2MQTT_DATA="$data" -e Z2M_ONBOARD_NO_SERVER=1 \
        -v "$dir/data:$data" -v "$e2e:/e2e:ro" "$@" >/dev/null
}

# The MQTT driver in mode $1 for serial port $2, adapter $3, scenario directory $4.
drive() {
    options=$(printf '{"mode":"%s","mqtt":"mqtt://127.0.0.1:%s","app":"/app","audit":"%s","coordinatorIeee":"0x%s","routerIeee":"%s","routerNwk":%s,"channel":%s,"panId":%s,"extendedPanId":"%s","serial":{"port":"%s","adapter":"%s"},"framing":"cobs-mux","timeoutMs":%s}' \
        "$1" "$mqtt_port" "$4/peer-audit.jsonl" "$coordinator_ieee" "$router_ieee" "$router_nwk" "$channel" \
        "$pan_id" "$ext_pan_id" "$2" "$3" "$((timeout_s * 1000))")
    docker run --rm --label "zerostack-adapter-e2e=$run" --network host -v "$e2e:/e2e:ro" -v "$4:$4:ro" \
        --entrypoint node "$gateway_image" /e2e/driver.mjs "$options" || {
        save_log "$4" gateway.log
        echo "gateway log tail:" >&2
        tail -n 40 "$4/gateway.log" >&2
        fail "driver ($1)"
    }
}

# The gateway's exit code once it stopped by itself within the timeout.
exit_code() {
    timeout "$timeout_s" docker wait "$run-gateway" || fail "gateway still running after ${timeout_s}s"
}

# PID and kernel start time of the gateway's node process.
node_process() {
    docker exec "$run-gateway" sh -c '
        set -- $(pidof node)
        [ "$#" -eq 1 ] || { echo "node processes: $*" >&2; exit 1; }
        stat=$(cat /proc/$1/stat)
        rest=${stat##*) }
        set -- $1 $rest
        eval "start=\${21}"
        echo "$1/$start"'
}

check_log() {
    count=$(grep -c -- "$2" "$1" || true)
    [ "$count" = "$3" ] || fail "log: '$2' appears $count times, expected $3"
    echo "PASS log: '$2' x$3"
}

scenario_hook() {
    echo "== Scenario 1: register hook, package outside node_modules"
    dir=$(make_data s1)
    current=$dir
    start_broker "$dir"
    start_peer "$dir" "$@"
    port="zs:tcp://127.0.0.1:$peer_port"
    write_config "$dir/data" "$port" zstack
    start_gateway "$dir" -e NODE_OPTIONS="--import $herdsman_dir/dist/hook.js" "$gateway_image"
    container=$(docker inspect -f '{{.Id}}' "$run-gateway")
    drive boot "$port" zstack "$dir"
    process=$(node_process)
    drive restart "$port" zstack "$dir"
    [ "$(docker inspect -f '{{.Id}}' "$run-gateway")" = "$container" ] || fail "6 gateway container changed"
    [ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$run-gateway")" = "true 0" ] ||
        fail "6 gateway container restarted"
    after=$(node_process)
    [ "$after" = "$process" ] || fail "6 node process changed: $process -> $after"
    echo "PASS 6 same container ${container%"${container#????????????}"} and node process $process (pid/start ticks)"
    save_log "$dir" gateway.log
    check_log "$dir/gateway.log" "Starting Zigbee2MQTT without watchdog" 2
    check_log "$dir/gateway.log" "zh:zerostack: zs coordinator started (" 2
    check_log "$dir/gateway.log" "\[zerostack-adapter\]" 0
    check_log "$dir/gateway.log" "\] error: " 0
    # Boot 1 forms the network on the blank peer; the peer power-cycles on reconnect and keeps its
    # NV, so boot 2 resumes from it without a backup restore.
    results=$(grep -o 'started ([a-z]*)' "$dir/gateway.log" | tr '\n' ' ')
    [ "$results" = "started (reset) started (reset) started (resumed) started (resumed) " ] ||
        fail "6 start results: $results"
    echo "PASS 6 start results (adapter, then gateway; boot 1, boot 2): $results"
    audit=$dir/peer-audit.jsonl
    last=$(grep -o '"connection":[0-9]*' "$audit" | cut -d: -f2 | sort -n | tail -n 1)
    first=$(grep "\"connection\":$last," "$audit" | head -n 1)
    [ "$first" = "{\"command\":128,\"connection\":$last,\"direction\":\"sent\",\"framing\":\"mt\",\"payload\":\"000201020701\",\"subsystem\":1,\"type\":2}" ] ||
        fail "6 the boot 2 link did not start with the peer's power-up SYS_RESET_IND: $first"
    echo "PASS 6 boot 2 link (peer connection $last) opened on a power-up: $first"
    stop_scenario
}

# Runs the gateway with the external-adapter configuration; $1 is the scenario directory, the rest
# the files of the compiled diff to apply ("none" for none, "all" for every file).
external_gateway() {
    dir=$1
    shift
    case $1 in
        none) apply="" ;;
        all) apply="node /e2e/apply-diff.mjs /e2e/external-adapter-compiled.diff /app && " ;;
        *) apply="node /e2e/apply-diff.mjs /e2e/external-adapter-compiled.diff /app $* && " ;;
    esac
    start_gateway "$dir" "$gateway_image" /sbin/tini -- sh -c "${apply}exec node index.js"
}

scenario_external() {
    echo "== Scenario 2: external adapter, compiled equivalent of docs/upstream applied"
    dir=$(make_data s2)
    current=$dir
    start_broker "$dir"
    start_peer "$dir" "$@"
    port="tcp://127.0.0.1:$peer_port"
    adapter=$herdsman_dir/dist/index.js
    write_config "$dir/data" "$port" "$adapter"

    external_gateway "$dir" none
    code=$(exit_code)
    save_log "$dir" negative-unpatched.log
    docker rm "$run-gateway" >/dev/null
    [ "$code" != 0 ] || fail "2-neg unpatched gateway exited 0"
    grep -q "serial/adapter must be equal to one of the allowed values" "$dir/negative-unpatched.log" ||
        fail "2-neg unpatched gateway did not reject serial.adapter"
    echo "PASS 2-neg unpatched: exit $code, $(grep -m1 'serial/adapter' "$dir/negative-unpatched.log")"

    external_gateway "$dir" dist/util/settings.schema.json
    code=$(exit_code)
    save_log "$dir" negative-schema-only.log
    docker rm "$run-gateway" >/dev/null
    [ "$code" != 0 ] || fail "2-neg schema-only gateway exited 0"
    grep -q "Adapter '$adapter' does not exists" "$dir/negative-schema-only.log" ||
        fail "2-neg schema-only gateway did not fail on the unknown adapter"
    echo "PASS 2-neg schema only: exit $code, $(grep -m1 -o "Adapter '[^']*' does not exists" "$dir/negative-schema-only.log")"

    [ "$(grep -c '"type":' "$dir/peer-audit.jsonl" || true)" = 0 ] || fail "2-neg a failed gateway reached the peer"

    external_gateway "$dir" all
    drive boot "$port" "$adapter" "$dir"
    save_log "$dir" gateway.log
    check_log "$dir/gateway.log" "^patched /app/" 3
    check_log "$dir/gateway.log" "zh:zerostack: zs coordinator started (" 1
    check_log "$dir/gateway.log" "\] error: " 0
    [ -z "$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$run-gateway" | grep '^NODE_OPTIONS=' || true)" ] ||
        fail "2 NODE_OPTIONS is set"
    echo "PASS 2 adapter: ZsAdapter ($(grep -m1 -o 'zs coordinator started ([a-z]*)' "$dir/gateway.log"), no NODE_OPTIONS)"
    stop_scenario
}

scenario_hook "$@"
scenario_external "$@"
echo "ALL CHECKS PASSED"
