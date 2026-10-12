start:
	pm2 start yarn --name eventando-manager -- run start

update:
	git pull
	yarn
	yarn build --no-optimization
	pm2 restart eventando-manager

# ---------------------------------------------------------------------------------------------
# Desenvolvimento em Docker (REA-21): só precisa do Docker na máquina. start e update, acima,
# são do deploy de produção (pm2 no servidor) e não usam nada daqui.
#   make dev     sobe MySQL + Strapi em http://localhost:1341/admin com recarga de código
#   make test    testes como no CI, inclusive o de integração com MySQL
#   make build   build como no CI           make lint    lint como no CI (lá não bloqueia)
#   make shell   terminal dentro do container
#   make down    para tudo                  make reset   para e apaga os volumes (banco e node_modules)
# ---------------------------------------------------------------------------------------------
DEV_COMPOSE = EVENTANDO_NODE_VERSION=$$(cat .nvmrc) EVENTANDO_GIT_DIR=$$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo $$PWD/.git) \
	DEV_UID=$$(id -u) DEV_GID=$$(id -g) \
	docker compose -f docker-compose.dev.yml --env-file .env.dev
DEV_RUN = $(DEV_COMPOSE) run --rm --build --no-deps eventando sh -c
DEV_INSTALL = yarn install --frozen-lockfile --network-timeout 600000 --silent
DEV_TEST_DB = eventando_test

.PHONY: dev down reset logs shell test build lint dev-setup

dev-setup:
	@test -f .env.dev || { cp .env.dev.example .env.dev && echo "Criei o .env.dev a partir do .env.dev.example."; }
	@touch .env
	@mkdir -p node_modules

dev: dev-setup
	$(DEV_COMPOSE) up --build

down: dev-setup
	$(DEV_COMPOSE) down

reset: dev-setup
	$(DEV_COMPOSE) down -v

logs: dev-setup
	$(DEV_COMPOSE) logs -f

shell: dev-setup
	$(DEV_COMPOSE) run --rm --build --no-deps eventando bash

# Como no CI: unitários com NODE_ENV=production; integração contra o MySQL num banco à parte.
test: dev-setup
	$(DEV_COMPOSE) up -d --wait eventando-db
	$(DEV_COMPOSE) exec -T eventando-db mysql -uroot -peventando-root \
		-e 'CREATE DATABASE IF NOT EXISTS $(DEV_TEST_DB)'
	$(DEV_RUN) '$(DEV_INSTALL) && NODE_ENV=production yarn test \
		&& DATABASE_NAME=$(DEV_TEST_DB) DATABASE_USERNAME=root DATABASE_PASSWORD=eventando-root yarn test:integration \
		&& bash .github/scripts/env-scripts.test.sh'

build: dev-setup
	$(DEV_RUN) '$(DEV_INSTALL) && NODE_ENV=production yarn build --no-optimization'

lint: dev-setup
	$(DEV_RUN) '$(DEV_INSTALL) && npx -y eslint@8 --no-eslintrc -c .eslintrc --parser espree --parser-options=ecmaVersion:2022 --ext .js config src'
