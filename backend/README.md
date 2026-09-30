# QueryDocs Backend

The backend for QueryDocs, a document question-and-answer application. It is a TypeScript Express API that provides authentication, document processing, semantic search, AI-generated answers, conversations, and dashboard statistics.

## Requirements

- Node.js 20 or later
- PostgreSQL 16 or a compatible PostgreSQL database
- A Supabase project for Storage and vector search
- A Gemini API key for embeddings and the default answer provider
- Docker Desktop is optional and provides the PostgreSQL container used by the included Compose file

## Setup

1. Build your queue SDK, then install this backend's dependencies. The SDK is linked from the sibling `../async-queue/client-sdk` folder, so build it first:

   ```bash
   cd ../../async-queue/client-sdk
   npm install
   npm run build
   cd ../../docs-query-RAG/backend
   npm install
   ```

2. Create an environment file:

   Windows PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

   macOS/Linux:

   ```bash
   cp .env.example .env
   ```

3. Set the required values in `.env`: `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET_NAME`. The service-role key is backend-only and must never be exposed to the frontend.

4. Start PostgreSQL with Docker, or point `DATABASE_URL` at an existing PostgreSQL database:

   ```bash
   docker compose up -d postgres
   ```

5. Start your Async Queue service from the sibling project. Configure its `.env` to use the PostgreSQL database started above (for example, `postgresql://postgres:postgres@localhost:5432/querydocs`), set its `WORKER_API_KEY`, then run from `../async-queue/backend`:

   ```bash
   npm run dev
   ```

   The queue service initializes its own `Job` and `FailedJob` tables in that database. Keep its `WORKER_API_KEY` equal to the value used by this application's document worker.

6. Generate Prisma Client and apply the Prisma schema:

   ```bash
   npm run db:generate
   npm run db:push
   ```

7. Run [`prisma/supabase-vector.sql`](prisma/supabase-vector.sql) in the Supabase SQL Editor. This creates the vector storage table, similarity-search function, and HNSW index used by document queries.

8. Start the API and the application-owned queue worker in separate terminals:

   ```bash
   npm run dev
   ```

   ```bash
   npm run worker:dev
   ```

The API listens on `http://localhost:8080` by default. The host, port, API prefix, and other defaults are defined in [`src/config/env.ts`](src/config/env.ts).

## Environment variables

All supported variables are listed in [`.env.example`](.env.example).

| Variable | Purpose | Default or requirement |
| --- | --- | --- |
| `NODE_ENV` | Runtime environment | `development` |
| `LOG_LEVEL` | Pino log level | `info` |
| `HOST` | Server bind address | `0.0.0.0` |
| `PORT` | HTTP port | `8080` |
| `API_PREFIX` | API route prefix | `/api/v1` |
| `CLIENT_ORIGIN` | Allowed CORS origin | `http://localhost:3000` |
| `DATABASE_URL` | PostgreSQL connection string | Local Docker database URL |
| `QUEUE_URL` | Async Queue API base URL | `http://localhost:4000` |
| `WORKER_API_KEY` | Shared key for the Async Queue service and this app's worker | Required to run the worker |
| `WORKER_CONCURRENCY` | Number of document jobs processed at once | `2` |
| `JWT_SECRET` | JWT signing secret | Development fallback; use a unique secret of at least 32 characters in production |
| `JWT_EXPIRES_IN` | JWT lifetime | `1h` |
| `UPLOAD_DIR` | Temporary upload directory | ./Dir_name |
| `MAX_FILE_SIZE_MB` | Maximum upload size | `10` |
| `LLM_PROVIDER` | Answer provider | `gemini` or `groq` |
| `GEMINI_MODEL` | Gemini answer model | `gemini-3.6-flash` |
| `GEMINI_API_KEY` | Gemini API credential | Required |
| `GROQ_MODEL` | Groq answer model | `MODEL_NAME` |
| `GROQ_API_KEY` | Groq API credential | Required when `LLM_PROVIDER=groq` |
| `GROQ_BASE_URL` | Groq API base URL | Required |
| `SUPABASE_URL` | Supabase project URL | Required |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase credential | Required |
| `SUPABASE_STORAGE_BUCKET_NAME` | Private document bucket | Required |

The server validates configuration when it starts. Embeddings always use Gemini's `gemini-embedding-2` model with 1536 output dimensions, regardless of the answer-generation provider.

## Database and storage

The Prisma schema stores users, documents, document chunks, conversations, and chat messages in PostgreSQL. The included [`docker-compose.yml`](docker-compose.yml) starts PostgreSQL with:

- Database: `querydocs`
- User: `postgres`
- Password: `postgres`
- Port: `5432`

The API uploads each original file to the configured private Supabase Storage bucket and submits a `process_document` job to Async Queue. The separate application worker downloads that durable source and extracts text, cleans it, splits it into chunks, generates embeddings, then writes chunk text to PostgreSQL and vectors to Supabase. Documents expose `queued`, `processing`, `ready`, or `failed` status; only `ready` documents can be queried. Stored files use the path `userId/documentId/originalFileName`.

## API

Unless stated otherwise, protected endpoints require:

```http
Authorization: Bearer <token>
```

The default prefix is `/api/v1`; replace it below when `API_PREFIX` is changed.

### Health and metadata

| Method | Endpoint | Authentication | Description |
| --- | --- | --- | --- |
| `GET` | `/` | No | Returns API metadata and the live health URL |
| `GET` | `/api/v1/health/live` | No | Confirms that the HTTP server is running |

### Authentication

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/api/v1/auth/register` | Creates an account |
| `POST` | `/api/v1/auth/login` | Authenticates an account and returns a token |
| `GET` | `/api/v1/auth/me` | Returns the authenticated user |

Registration accepts `name`, `email`, and a password between 8 and 72 characters. Login accepts `email` and `password`.

### Documents

All document endpoints are protected.

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/api/v1/documents` | Uploads one `.txt`, `.pdf`, or `.docx` file as multipart field `file`; returns `202 Accepted` with the document and Async Queue job ID; optional field: `name` |
| `GET` | `/api/v1/documents` | Lists the user's documents |
| `GET` | `/api/v1/documents/stats` | Returns the user's document statistics |
| `GET` | `/api/v1/documents/:id` | Returns one owned document |
| `PATCH` | `/api/v1/documents/:id` | Renames a document with `{ "name": "New name" }` |
| `DELETE` | `/api/v1/documents/:id` | Deletes a document and its stored file |

The upload limit is controlled by `MAX_FILE_SIZE_MB` and defaults to 10 MB.

### Conversations and queries

All conversation and query endpoints are protected.

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/api/v1/conversations` | Creates a conversation |
| `GET` | `/api/v1/conversations` | Lists the user's conversations |
| `GET` | `/api/v1/conversations/:id` | Returns a conversation and its messages |
| `PATCH` | `/api/v1/conversations/:id` | Renames a conversation with `{ "title": "New title" }` |
| `DELETE` | `/api/v1/conversations/:id` | Deletes a conversation |
| `POST` | `/api/v1/query` | Answers a question using selected documents |

Query requests must include a conversation ID, a question of up to 2,000 characters, and one or more unique document IDs:

```json
{
  "conversationId": "conversation-id",
  "question": "What does this document say?",
  "documentIds": ["document-id"]
}
```

### Dashboard

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/v1/dashboard/stats` | Returns authenticated-user dashboard statistics |

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Starts the development server with `tsx watch` |
| `npm run build` | Compiles TypeScript to `dist` |
| `npm start` | Runs `dist/server.js` |
| `npm run typecheck` | Runs TypeScript checks without emitting files |
| `npm test` | Runs tests with Node's built-in test runner and `tsx` |
| `npm run db:generate` | Generates Prisma Client |
| `npm run db:push` | Synchronizes the Prisma schema with the database |
| `npm run db:studio` | Opens Prisma Studio |

## Project structure

```text
src/
  config/                 Environment, Prisma, and logging configuration
  infrastructure/         Document processing, AI providers, storage, and vector search
  middleware/             Authentication, uploads, rate limiting, logging, and errors
  modules/                Auth, documents, conversations, dashboard, health, and query features
  types/                  Express type declarations
prisma/
  schema.prisma            PostgreSQL data model
  supabase-vector.sql      Supabase pgvector setup
uploads/
  .gitkeep                 Temporary local upload directory
```

## Logging and production notes

The API uses Pino for structured logging. Valid `LOG_LEVEL` values are `trace`, `debug`, `info`, `warn`, `error`, `fatal`, and `silent`. Request logging intentionally excludes bodies, passwords, tokens, and other sensitive values.

For production, use a strong unique `JWT_SECRET`, secure database credentials, private Supabase Storage, restricted CORS origins, and appropriately managed API keys. Do not commit `.env` or expose `SUPABASE_SERVICE_ROLE_KEY` to clients.
