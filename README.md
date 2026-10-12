# 🚀 Getting started with Strapi

## Desenvolvimento em Docker

Só precisa do Docker (macOS ou Linux). A versão do Node fica no `.nvmrc`, a mesma do CI e da produção.

```bash
make dev     # sobe MySQL + Strapi em http://localhost:1341/admin, com recarga de código
make test    # testes, como no CI
make build   # build, como no CI
make lint    # lint, como no CI (lá ele não bloqueia)
make shell   # terminal dentro do container
make down    # para; make reset também apaga os volumes (banco e node_modules)
```

Na primeira vez, o `make` cria o `.env.dev` a partir do `.env.dev.example` (o `.env.dev` fica fora
do git). Dentro do container o `.env` é o `.env.dev`: o `.env` da máquina nunca é lido.

`make test` roda também o teste de integração com MySQL, como o CI, num banco à parte
(`eventando_test`) do mesmo MySQL, sem tocar nos dados do `make dev`. O banco de desenvolvimento
fica na porta 3308 da máquina. O plugin que o `yarn.lock` fixa por git+ssh é baixado por HTTPS
dentro do container, como no CI. Para o BFF local falar com este Strapi, crie em Settings -> API
Tokens um token "Full access" e cole no `.env.dev` do hub-community-bff. A stack inteira sobe com
`make hub` no hub-community-frontend.

O deploy de produção não usa nada disso: continua com `make update` (pm2) no servidor.

Strapi comes with a full featured [Command Line Interface](https://docs.strapi.io/dev-docs/cli) (CLI) which lets you scaffold and manage your project in seconds.

### `develop`

Start your Strapi application with autoReload enabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-develop)

```
npm run develop
# or
yarn develop
```

### `start`

Start your Strapi application with autoReload disabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-start)

```
npm run start
# or
yarn start
```

### `build`

Build your admin panel. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-build)

```
npm run build
# or
yarn build
```

## ⚙️ Deployment

Strapi gives you many possible deployment options for your project including [Strapi Cloud](https://cloud.strapi.io). Browse the [deployment section of the documentation](https://docs.strapi.io/dev-docs/deployment) to find the best solution for your use case.

```
yarn strapi deploy
```

## 📚 Learn more

- [Resource center](https://strapi.io/resource-center) - Strapi resource center.
- [Strapi documentation](https://docs.strapi.io) - Official Strapi documentation.
- [Strapi tutorials](https://strapi.io/tutorials) - List of tutorials made by the core team and the community.
- [Strapi blog](https://strapi.io/blog) - Official Strapi blog containing articles made by the Strapi team and the community.
- [Changelog](https://strapi.io/changelog) - Find out about the Strapi product updates, new features and general improvements.

Feel free to check out the [Strapi GitHub repository](https://github.com/strapi/strapi). Your feedback and contributions are welcome!

## ✨ Community

- [Discord](https://discord.strapi.io) - Come chat with the Strapi community including the core team.
- [Forum](https://forum.strapi.io/) - Place to discuss, ask questions and find answers, show your Strapi project and get feedback or just talk with other Community members.
- [Awesome Strapi](https://github.com/strapi/awesome-strapi) - A curated list of awesome things related to Strapi.

---

<sub>🤫 Psst! [Strapi is hiring](https://strapi.io/careers).</sub>
