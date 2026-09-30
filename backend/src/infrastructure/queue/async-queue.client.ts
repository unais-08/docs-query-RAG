import { createQueueClient } from '@async-queue/client';
import { env } from '../../config/env.js';

export const asyncQueue = createQueueClient({ queueUrl: env.QUEUE_URL });

export type ProcessDocumentPayload = {
  documentId: string;
  userId: string;
  storagePath: string;
};

export const enqueueDocumentProcessing = (payload: ProcessDocumentPayload) =>
  asyncQueue.submit('process_document', payload, 3);
