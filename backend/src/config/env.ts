import 'dotenv/config';
import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  API_PREFIX: z.string().startsWith('/').default('/api/v1'),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().url().default('postgresql://postgres:postgres@localhost:5432/querydocs?schema=public'),
  QUEUE_URL: z.string().url().default('http://localhost:4000'),
  WORKER_API_KEY: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),

  JWT_SECRET: z.string().min(32).default('change-this-development-secret-at-least-32-chars'),
  JWT_EXPIRES_IN: z.string().default('1h'),

  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(10),

  LLM_PROVIDER: z.enum(['gemini', 'groq']).default('gemini'),

  GEMINI_MODEL: z.string().default('gemini-3.6-flash'),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),

  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET_NAME: z.string().min(1)
});

export const env = environmentSchema.parse(process.env);
