#!/usr/bin/env bash
# netem_apply.sh — run LOCALLY on one generator host, as root (via sudo).
# Shapes traffic between this host and the Trussal VM subnet only; ssh/console
# stays unshaped.
#
#   netem_apply.sh apply  <iface> <subnet> <delay_ms> <jitter_ms> <loss%> <loss_corr%> \
#                         <reorder%> <dup%> <corrupt%> <rate_down_kbit> <rate_up_kbit> <backlog>
#   netem_apply.sh handover-start <iface> <stall_ms> <burst_loss%> <burst_s> <every_min_s> <every_max_s>
#   netem_apply.sh handover-stop
#   netem_apply.sh clear  <iface>
#   netem_apply.sh show   <iface>
set -euo pipefail

IFB=ifb0
HANDOVER_PIDFILE=/run/lt_netem_handover.pid

die() { echo "netem_apply: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "must run as root"

cmd=${1:-}; shift || true

case "$cmd" in
apply)
  IFACE=$1 SUBNET=$2 D=$3 J=$4 L=$5 LC=$6 RE=$7 DUP=$8 COR=$9 RDOWN=${10} RUP=${11} BL=${12}
  "$0" clear "$IFACE" || true

  UPRATE=${RUP}; [[ "$UPRATE" == "0" ]] && UPRATE=10000000   # ~10gbit = effectively unshaped
  DOWNRATE=${RDOWN}; [[ "$DOWNRATE" == "0" ]] && DOWNRATE=10000000

  netem_opts="limit ${BL}"
  [[ "$D" != "0" || "$J" != "0" ]] && netem_opts="$netem_opts delay ${D}ms ${J}ms distribution normal"
  awk "BEGIN{exit !($L>0)}"  && netem_opts="$netem_opts loss ${L}% ${LC}%"
  awk "BEGIN{exit !($RE>0)}" && netem_opts="$netem_opts reorder ${RE}% 50%"
  awk "BEGIN{exit !($DUP>0)}" && netem_opts="$netem_opts duplicate ${DUP}%"
  awk "BEGIN{exit !($COR>0)}" && netem_opts="$netem_opts corrupt ${COR}%"

  # ---- egress (uplink) ----
  tc qdisc add dev "$IFACE" root handle 1: htb default 1
  tc class add dev "$IFACE" parent 1:  classid 1:1  htb rate 10000000kbit           # unshaped bulk
  tc class add dev "$IFACE" parent 1:  classid 1:10 htb rate "${UPRATE}kbit" ceil "${UPRATE}kbit"
  tc qdisc add dev "$IFACE" parent 1:10 handle 10: netem $netem_opts
  tc filter add dev "$IFACE" protocol ip parent 1:0 prio 1 u32 \
     match ip dst "$SUBNET" flowid 1:10

  # ---- ingress (downlink) via ifb ----
  # `modprobe ifb numifbs=1` is a no-op if ifb is already loaded (possibly with
  # numifbs=0), so the device may not exist; create it explicitly as a fallback.
  modprobe ifb numifbs=1 2>/dev/null || true
  ip link show "$IFB" >/dev/null 2>&1 || ip link add "$IFB" type ifb
  ip link set "$IFB" up
  tc qdisc add dev "$IFACE" handle ffff: ingress
  tc filter add dev "$IFACE" parent ffff: protocol ip prio 1 u32 \
     match ip src "$SUBNET" action mirred egress redirect dev "$IFB"
  tc qdisc add dev "$IFB" root handle 1: htb default 1
  tc class add dev "$IFB" parent 1: classid 1:1  htb rate 10000000kbit
  tc class add dev "$IFB" parent 1: classid 1:10 htb rate "${DOWNRATE}kbit" ceil "${DOWNRATE}kbit"
  tc qdisc add dev "$IFB" parent 1:10 handle 10: netem $netem_opts
  tc filter add dev "$IFB" protocol ip parent 1:0 prio 1 u32 \
     match ip src "$SUBNET" flowid 1:10

  echo "netem_apply: applied on $IFACE (up=${RUP}kbit down=${RDOWN}kbit; $netem_opts) toward $SUBNET"
  ;;

handover-start)
  IFACE=$1 STALL_MS=$2 BURST_L=$3 BURST_S=$4 EMIN=$5 EMAX=$6
  "$0" handover-stop || true
  (
    while true; do
      span=$(( EMIN + RANDOM % (EMAX - EMIN + 1) ))
      sleep "$span"
      # stall: huge delay + burst loss on both directions
      tc qdisc change dev "$IFACE" parent 1:10 handle 10: netem delay "${STALL_MS}ms" loss "${BURST_L}%" || true
      tc qdisc change dev "$IFB"   parent 1:10 handle 10: netem delay "${STALL_MS}ms" loss "${BURST_L}%" || true
      sleep "$BURST_S"
      # restore is done by the next `apply` of the base profile; here we just
      # drop the extra delay back toward base by re-reading is overkill — the
      # campaign re-applies the base profile between steps. Approximate restore:
      tc qdisc change dev "$IFACE" parent 1:10 handle 10: netem delay 65ms 35ms distribution normal loss 1.5% 30% || true
      tc qdisc change dev "$IFB"   parent 1:10 handle 10: netem delay 65ms 35ms distribution normal loss 1.5% 30% || true
    done
  ) &
  echo $! > "$HANDOVER_PIDFILE"
  echo "netem_apply: handover loop pid $(cat "$HANDOVER_PIDFILE")"
  ;;

handover-stop)
  [[ -f "$HANDOVER_PIDFILE" ]] && kill "$(cat "$HANDOVER_PIDFILE")" 2>/dev/null || true
  rm -f "$HANDOVER_PIDFILE"
  ;;

clear)
  IFACE=$1
  "$0" handover-stop || true
  tc qdisc del dev "$IFACE" root 2>/dev/null || true
  tc qdisc del dev "$IFACE" ingress 2>/dev/null || true
  tc qdisc del dev "$IFB" root 2>/dev/null || true
  ip link set "$IFB" down 2>/dev/null || true
  echo "netem_apply: cleared $IFACE"
  ;;

show)
  IFACE=$1
  echo "== $IFACE root =="; tc -s qdisc show dev "$IFACE" || true
  echo "== $IFB root =="; tc -s qdisc show dev "$IFB" 2>/dev/null || true
  ;;

*)
  die "usage: apply|handover-start|handover-stop|clear|show ..."
  ;;
esac
