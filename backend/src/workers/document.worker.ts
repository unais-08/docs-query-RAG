import { extname } from 'node:path';
import { inspect } from 'node:util';
import {
  registerHandler,
  startWorker
} from '@async-queue/client';
import { NonRetryableJobError } from '@async-queue/client';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { documentProcessingService } from '../infrastructure/document-processing/document.processing.service.js';
import {
  deleteChunkVectorsForDocument,
  upsertChunkVectors
} from '../infrastructure/vector-store/supabase.vector.service.js';
import {
  downloadDocumentToTempFile
} from '../infrastructure/storage/supabase.storage.service.js';
import { removeStoredFile } from '../modules/documents/file.localdisk.storage.js';
import {
  createDocumentChunks,
  deleteDocumentChunks,
  updateDocumentProcessing
} from '../modules/documents/document.service.js';
import type { ProcessDocumentPayload } from '../infrastructure/queue/async-queue.client.js';

if (!env.WORKER_API_KEY) throw new Error('WORKER_API_KEY is required to run the document worker');

const normalizeJobError = (error: unknown): Error => {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return new Error(error.message, { cause: error });
  }
  return new Error(inspect(error, { depth: 5, breakLength: 120 }), { cause: error });
};

registerHandler<ProcessDocumentPayload>('process_document', async ({ documentId, userId, storagePath }) => {
  const document = await prisma.document.findFirst({
    where: { id: documentId, userId },
    select: { id: true, storagePath: true, originalFileName: true }
  });

  // A queued job may outlive its document if the user deletes it.
  if (!document) return;
  if (!document.storagePath || document.storagePath !== storagePath) {
    await updateDocumentProcessing(documentId, 'failed', 'Document source file is unavailable');
    throw new NonRetryableJobError('Document source file is unavailable');
  }

  await updateDocumentProcessing(documentId, 'processing');
  let filePath: string | undefined;

  try {
    const processedDocument = await (async () => {
      filePath = await downloadDocumentToTempFile(storagePath, extname(document.originalFileName));
      return documentProcessingService.extractAndChunk(filePath);
    })();

    // Make retries safe by removing any partial data from an earlier attempt.
    await deleteChunkVectorsForDocument(documentId, userId);
    await deleteDocumentChunks(documentId);
    const storedChunks = await createDocumentChunks(documentId, userId, processedDocument.chunks);
    const chunkIds = storedChunks.map((chunk) => chunk.id);

    try {
      await upsertChunkVectors(processedDocument.chunks.map((chunk, index) => {
        const storedChunk = storedChunks[index];
        if (!storedChunk) throw new Error(`Missing stored chunk for index ${chunk.index}`);
        return {
          id: storedChunk.id,
          chunkId: storedChunk.id,
          userId,
          documentId,
          chunkIndex: chunk.index,
          pageNumber: chunk.pageNumber ?? null,
          embedding: chunk.embedding
        };
      }));
    } catch (error) {
      await deleteChunkVectorsForDocument(documentId, userId).catch(() => undefined);
      await prisma.documentChunk.deleteMany({ where: { id: { in: chunkIds } } }).catch(() => undefined);
      throw error;
    }

    await updateDocumentProcessing(documentId, 'ready');
    logger.info({ documentId, chunkCount: storedChunks.length, characterCount: processedDocument.characterCount }, 'Document processing completed');
  } catch (error) {
    await deleteChunkVectorsForDocument(documentId, userId).catch(() => undefined);
    await deleteDocumentChunks(documentId).catch(() => undefined);
    const jobError = normalizeJobError(error);
    logger.error({ err: jobError, documentId }, 'Document processing job failed');
    await updateDocumentProcessing(documentId, 'failed', jobError.message.slice(0, 500)).catch(() => undefined);
    throw jobError;
  } finally {
    if (filePath) await removeStoredFile(filePath).catch((error) => logger.warn({ err: error, documentId }, 'Could not remove worker temp file'));
  }
});

const start = async () => {
  await prisma.$connect();
  const worker = startWorker({
    queueUrl: env.QUEUE_URL,
    workerKey: env.WORKER_API_KEY!,
    concurrency: env.WORKER_CONCURRENCY
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Stopping document worker');
    await worker.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  logger.info({ concurrency: env.WORKER_CONCURRENCY }, 'Document worker started');
};

void start().catch((error) => {
  logger.error({ err: error }, 'Document worker failed to start');
  process.exitCode = 1;
});
