# Trussal multi-VM deployment
#
# Prerequisites:
#   1. Copy .env.deploy.example → .env.deploy and fill in the three VM addresses.
#   2. Each VM must have the repo cloned at REPO_PATH and your SSH public key
#      in authorized_keys.
#   3. Video VM: user must be in the docker group.
#   4. Audio VM: the Jamulus servers run as SYSTEM units
#      (/etc/systemd/system/jamulus@<port>.service, User=trussal-audio). The
#      deploy user needs passwordless sudo (NOPASSWD) for the three commands
#      `deploy-audio` runs: installing the unit file, `systemctl daemon-reload`,
#      and `systemctl restart jamulus@*`. NOTE: deploy-audio overwrites the
#      deployed unit from system/jamulus@.service — edit the unit in the repo,
#      not on the box, or your change will be reverted on the next deploy.
#
# Usage:
#   make deploy-video   rebuild custom-config.js, push to video VM, restart Jitsi
#   make deploy-audio   push updated Jamulus unit file, restart Jamulus instances
#   make deploy-bots    rebuild bot images, restart conductor
#   make deploy-all     all three in sequence

-include .env.deploy

VIDEO_VM        ?= trussal-video@192.168.1.254
AUDIO_VM        ?= trussal-audio@192.168.1.120
BOTS_VM         ?= trussal-bot-vm@192.168.1.232
REPO_PATH       ?= ~/Trussal
VIDEO_REPO_PATH ?= $(REPO_PATH)
AUDIO_REPO_PATH ?= $(REPO_PATH)
BOTS_REPO_PATH  ?= $(REPO_PATH)

# Multi-shard (edge/README.md, docker-jitsi-meet/MULTISHARD.md): SHARD_VMS is a
# space-separated `user@host` list, one FULL Jitsi stack per host, each behind
# the consistent-hash edge on EDGE_VM. Unset => the single VIDEO_VM, i.e. the
# existing single-stack deploy, unchanged. EDGE_VM unset => no edge step.
SHARD_VMS       ?= $(VIDEO_VM)
EDGE_VM         ?=
SHARD_REPO_PATH ?= $(REPO_PATH)
EDGE_REPO_PATH  ?= $(REPO_PATH)

# run.sh rebuilds the bundle on the video VM, and build.mjs bakes in the
# Jamulus hostname from JAMULUS_HOST (shell env or a repo-root .env, which no
# VM has). Passing it here is what keeps that rebuild from silently baking the
# jamulus.example.com default into the SERVED bundle and leaving the tracked
# custom-config.js dirty, which breaks the next `git pull --ff-only`.
JAMULUS_HOST    ?= jamulus.trussal.com

.PHONY: deploy-video deploy-shards deploy-edge deploy-audio deploy-bots \
        deploy-all deploy-multishard check-tokens collect-session-logs

deploy-video:
	ssh $(VIDEO_VM) 'cd $(VIDEO_REPO_PATH) && git pull --ff-only && JAMULUS_HOST=$(JAMULUS_HOST) ./run.sh'

# One FULL Jitsi stack per shard host. `run.sh` is already per-host and needs no
# shard argument — shard identity (DEPLOYMENTINFO_SHARD, JVB_* ) lives in that
# host's gitignored docker-jitsi-meet/.env (docker-jitsi-meet/MULTISHARD.md).
# Serial, and it aborts on the first failure rather than half-deploying the rack.
deploy-shards:
	@for vm in $(SHARD_VMS); do \
	  echo "=== shard $$vm ==="; \
	  ssh $$vm 'cd $(SHARD_REPO_PATH) && git pull --ff-only && JAMULUS_HOST=$(JAMULUS_HOST) ./run.sh' || exit 1; \
	done

# The edge host: the consistent-hash LB (edge/README.md) plus the rack's one
# coturn + ddns. Validates haproxy.cfg before the seamless reload so a typo
# can't take the site down, then self-heals coturn's TURN_EXTERNAL_IP and
# (re)installs its refresh cron.
deploy-edge:
	@[ -n "$(EDGE_VM)" ] || echo "EDGE_VM unset in .env.deploy — no edge tier, skipping"
	@[ -z "$(EDGE_VM)" ] || ssh $(EDGE_VM) 'cd $(EDGE_REPO_PATH) && git pull --ff-only && cd edge \
	  && docker compose up -d \
	  && docker compose exec -T edge haproxy -c -V -f /usr/local/etc/haproxy/haproxy.cfg \
	  && docker compose kill -s HUP edge \
	  && cd .. \
	  && TURN_ENV_FILE=edge/.env TURN_COMPOSE_DIR=edge bash scripts/refresh-turn-external-ip.sh \
	  && ( crontab -l 2>/dev/null | grep -vF "refresh-turn-external-ip.sh"; \
	       echo "*/5 * * * * cd $(EDGE_REPO_PATH) && TURN_ENV_FILE=edge/.env TURN_COMPOSE_DIR=edge bash scripts/refresh-turn-external-ip.sh >> \$$HOME/turn-ip-refresh.log 2>&1" ) | crontab - \
	  && echo "edge reloaded; TURN IP refresh cron installed"'

deploy-audio:
	ssh $(AUDIO_VM) 'cd $(AUDIO_REPO_PATH) && git pull --ff-only \
	  && sudo -n install -m 0644 system/jamulus@.service /etc/systemd/system/jamulus@.service \
	  && sudo -n systemctl daemon-reload \
	  && sudo -n systemctl restart "jamulus@*"'

deploy-bots:
	ssh $(BOTS_VM) 'cd $(BOTS_REPO_PATH) && git pull --ff-only \
	  && cd bots \
	  && docker compose --profile build-only build \
	  && docker compose up -d --force-recreate conductor \
	  && cd .. && bash scripts/check-control-token.sh bots' \
	  || echo "WARNING: bots deployed, but the control token is missing/stale — no aggregator will spawn."

# The control-channel secret lives only in gitignored .env files across the VMs
# (SIDECAR_CONTROL_TOKEN in every shard's docker-jitsi-meet/.env, and
# FLEET_CONTROL_TOKEN in bots/.env), and every compose file defaults it to empty
# rather than failing — so the set can be absent OR mismatched with no error
# anywhere except a conductor log flooding one line every 2s. No VM can check
# another, so this compares sha256 fingerprints of what each side actually
# holds; the secrets never leave their hosts. Fatal: a wrong set means the fleet
# is dead no matter how cleanly everything else deployed. Every shard's token
# must match the one bots/.env holds, or that shard discovers no rooms.
check-tokens:
	@bots=$$(ssh $(BOTS_VM) 'cd $(BOTS_REPO_PATH) && bash scripts/check-control-token.sh bots' | sed -n 's/^FINGERPRINT //p'); \
	if [ -z "$$bots" ]; then echo "FAIL: bots VM has no usable control token (diagnosis above)."; exit 1; fi; \
	rc=0; \
	for vm in $(SHARD_VMS); do \
	  fp=$$(ssh $$vm 'cd $(SHARD_REPO_PATH) && bash scripts/check-control-token.sh video' | sed -n 's/^FINGERPRINT //p'); \
	  if [ -z "$$fp" ]; then echo "FAIL: shard $$vm has no usable control token (diagnosis above)."; rc=1; \
	  elif [ "$$fp" != "$$bots" ]; then \
	    echo "FAIL: shard $$vm holds a DIFFERENT control token (shard sha $$fp, bots sha $$bots)."; \
	    echo "  That shard discovers no rooms. Set its docker-jitsi-meet/.env SIDECAR_CONTROL_TOKEN"; \
	    echo "  to the value in bots/.env, then: cd docker-jitsi-meet && docker compose up -d --force-recreate latency"; \
	    rc=1; \
	  else echo "  ✓ shard $$vm agrees (sha $$fp)"; fi; \
	done; \
	[ $$rc -eq 0 ] && echo "control token OK — every shard agrees with the bots VM (sha $$bots)"; \
	exit $$rc

# Each shard writes its `latency` sidecar's SESSION_LOG_DIR JSONL locally; pull
# them together for loadtest/analysis/ingest.py. SESSION_LOG_REMOTE is the path
# inside each shard's repo (default matches docker-jitsi-meet's compose mount).
SESSION_LOG_REMOTE ?= $(SHARD_REPO_PATH)/docker-jitsi-meet/session-logs
SESSION_LOG_LOCAL  ?= loadtest/results/_session-logs
collect-session-logs:
	@mkdir -p $(SESSION_LOG_LOCAL)
	@for vm in $(SHARD_VMS); do \
	  name=$${vm##*@}; \
	  echo "=== $$vm -> $(SESSION_LOG_LOCAL)/$$name ==="; \
	  rsync -az --ignore-missing-args $$vm:$(SESSION_LOG_REMOTE)/ $(SESSION_LOG_LOCAL)/$$name/ || true; \
	done

# Single-stack deploy (unchanged): one video VM, no edge.
deploy-all: deploy-video deploy-audio deploy-bots check-tokens

# Sharded rack: edge first, then every shard, then audio + bots, then verify the
# control token across the whole set.
deploy-multishard: deploy-edge deploy-shards deploy-audio deploy-bots check-tokens
