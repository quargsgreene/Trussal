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

.PHONY: deploy-video deploy-audio deploy-bots deploy-all

deploy-video:
	ssh $(VIDEO_VM) 'cd $(VIDEO_REPO_PATH) && git pull --ff-only && ./run.sh'
deploy-audio:
	ssh $(AUDIO_VM) 'cd $(AUDIO_REPO_PATH) && git pull --ff-only \
	  && sudo -n install -m 0644 system/jamulus@.service /etc/systemd/system/jamulus@.service \
	  && sudo -n systemctl daemon-reload \
	  && sudo -n systemctl restart "jamulus@*"'

deploy-bots:
	ssh $(BOTS_VM) 'cd $(BOTS_REPO_PATH) && git pull --ff-only \
	  && cd bots \
	  && docker compose --profile build-only build \
	  && docker compose up -d conductor'

deploy-all: deploy-video deploy-audio deploy-bots
