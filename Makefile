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

# run.sh rebuilds the bundle on the video VM, and build.mjs bakes in the
# Jamulus hostname from JAMULUS_HOST (shell env or a repo-root .env, which no
# VM has). Passing it here is what keeps that rebuild from silently baking the
# jamulus.example.com default into the SERVED bundle and leaving the tracked
# custom-config.js dirty, which breaks the next `git pull --ff-only`.
JAMULUS_HOST    ?= jamulus.trussal.com

.PHONY: deploy-video deploy-audio deploy-bots deploy-all check-tokens

deploy-video:
	ssh $(VIDEO_VM) 'cd $(VIDEO_REPO_PATH) && git pull --ff-only && JAMULUS_HOST=$(JAMULUS_HOST) ./run.sh'
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

# The control-channel secret lives only in two gitignored .env files on two
# different VMs, and both compose files default it to empty rather than failing,
# so the pair can be absent OR mismatched with no error anywhere except a
# conductor log flooding one line every 2s. Neither VM can check the other, so
# this compares sha256 fingerprints of what each side has actually got — the
# secrets themselves never leave their hosts. Fatal: a wrong pair means the
# fleet is dead no matter how cleanly everything else deployed.
check-tokens:
	@video=$$(ssh $(VIDEO_VM) 'cd $(VIDEO_REPO_PATH) && bash scripts/check-control-token.sh video' | sed -n 's/^FINGERPRINT //p'); \
	bots=$$(ssh $(BOTS_VM) 'cd $(BOTS_REPO_PATH) && bash scripts/check-control-token.sh bots' | sed -n 's/^FINGERPRINT //p'); \
	if [ -z "$$video" ] || [ -z "$$bots" ]; then \
	  [ -n "$$video" ] || echo "FAIL: video VM has no usable control token (diagnosis above)."; \
	  [ -n "$$bots" ]  || echo "FAIL: bots VM has no usable control token (diagnosis above)."; \
	  exit 1; \
	fi; \
	if [ "$$video" != "$$bots" ]; then \
	  echo "FAIL: the two VMs hold DIFFERENT control tokens (video sha $$video, bots sha $$bots)."; \
	  echo "  Room discovery is refused, so no aggregator spawns in any room. Copy the"; \
	  echo "  video VM's SIDECAR_CONTROL_TOKEN into bots/.env as FLEET_CONTROL_TOKEN, then:"; \
	  echo "    cd bots && docker compose up -d --force-recreate conductor"; \
	  exit 1; \
	fi; \
	echo "control token OK — both VMs agree (sha $$video)"

deploy-all: deploy-video deploy-audio deploy-bots check-tokens
