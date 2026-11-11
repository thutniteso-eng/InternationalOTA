# InternationalOTA

Independently owned online travel platform (tours/activities and hotels first, Vietnam first).

- Start here: [`CLAUDE.md`](CLAUDE.md)
- Current status: [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md)
- Standards: [`docs/ENGINEERING_STANDARDS.md`](docs/ENGINEERING_STANDARDS.md)
- Tasks for the implementation agent: [`implementation/tasks/`](implementation/tasks/)

## Local development

### Prerequisites
- Node.js >= 24 LTS (specified in `.nvmrc`)
- pnpm 10 via Corepack (`corepack enable`)
- Docker & Docker Compose

### Setup
1. Enable Corepack and pnpm:
   ```bash
   corepack enable
   ```
2. Install dependencies:
   ```bash
   pnpm install --frozen-lockfile
   ```
3. Copy environment configuration:
   ```bash
   cp .env.example .env
   ```
4. Start local infrastructure services (PostgreSQL with PostGIS on port 55432, Redis 7 on port 56379):
   ```bash
   docker compose up -d
   ```
   Verify services are healthy:
   ```bash
   docker compose ps
   ```

### Quality & build commands
- Lint all workspaces:
  ```bash
  pnpm lint
  ```
- Typecheck all workspaces:
  ```bash
  pnpm typecheck
  ```
- Run all tests across workspaces:
  ```bash
  pnpm test
  ```
- Build all workspaces:
  ```bash
  pnpm build
  ```
- Check code formatting:
  ```bash
  pnpm format:check
  ```

### Running applications in development
- Start API (NestJS):
  ```bash
  pnpm --filter @internationalota/api dev
  ```
  Health check:
  ```bash
  curl http://localhost:4000/health
  ```
  *(Port can be customized using `API_PORT=<port>`)*

- Start Web (Next.js):
  ```bash
  pnpm --filter @internationalota/web dev
  ```
  Access at `http://localhost:3000`.
