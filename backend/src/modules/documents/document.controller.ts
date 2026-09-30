import type { NextFunction, Request, Response } from 'express';
import {
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentStats,
  listDocuments,
  renameDocument,
  setDocumentStoragePath,
} from './document.service.js';
import { documentIdSchema, renameDocumentSchema, uploadDocumentFieldsSchema } from './document.schemas.js';
import { DocumentError } from './document.errors.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../config/prisma.js';
import { deleteDocument as deleteSupabaseDocument, uploadDocument } from '../../infrastructure/storage/supabase.storage.service.js';
import { removeStoredFile } from './file.localdisk.storage.js';
import { enqueueDocumentProcessing } from '../../infrastructure/queue/async-queue.client.js';
import { deleteChunkVectorsForDocument } from '../../infrastructure/vector-store/supabase.vector.service.js';


export const upload = async (request: Request, response: Response, next: NextFunction) => {
  let createdDocumentId: string | null = null;
  let storagePath: string | null = null;

  try {
    if (!request.file) {
      throw new DocumentError('A document file is required', 400, 'FILE_REQUIRED');
    }

    const fields = uploadDocumentFieldsSchema.parse(request.body);
    const result = await createDocument(request.userId, request.file, fields.name);
    const documentId = result.document.id;
    createdDocumentId = documentId;

    storagePath = await uploadDocument(
      request.file.path,
      request.userId,
      documentId,
      request.file.originalname,
      request.file.mimetype
    );
    await setDocumentStoragePath(documentId, storagePath);
    const job = await enqueueDocumentProcessing({ documentId, userId: request.userId, storagePath });
    await removeStoredFile(request.file.path).catch((cleanupError) => {
      logger.warn({ err: cleanupError, documentId }, 'Could not remove temporary upload file');
    });

    logger.info(
      { documentId, jobId: job.jobId },
      'Document uploaded and queued for processing'
    );

    response.status(202).json({ ...result, jobId: job.jobId });
  } catch (error) {
    // Clean up if storage or job submission fails before the request is accepted.
    if (createdDocumentId) {
      await prisma.document.delete({ where: { id: createdDocumentId } }).catch(() => undefined);
    }

    if (storagePath) {
      await deleteSupabaseDocument(storagePath).catch(() => undefined);
    }
    if (request.file?.path) await removeStoredFile(request.file.path).catch(() => undefined);

    next(error);
  }
};


export const list = async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.status(200).json(await listDocuments(request.userId));
  } catch (error) {
    next(error);
  }
};

export const getById = async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.status(200).json(await getDocument(request.userId, documentIdSchema.parse(request.params.id)));
  } catch (error) {
    next(error);
  }
};

export const rename = async (request: Request, response: Response, next: NextFunction) => {
  try {
    const id = documentIdSchema.parse(request.params.id);
    const { name } = renameDocumentSchema.parse(request.body);
    response.status(200).json(await renameDocument(request.userId, id, name));
  } catch (error) {
    next(error);
  }
};

export const remove = async (request: Request, response: Response, next: NextFunction) => {
  try {
    const documentId = documentIdSchema.parse(request.params.id);

    // Remove the document's embeddings before deleting its database record.
    // This keeps vectors from remaining after their source text is deleted.
    await deleteChunkVectorsForDocument(documentId, request.userId);
    await deleteDocument(request.userId, documentId);
    response.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const stats = async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.status(200).json(await getDocumentStats(request.userId));
  } catch (error) {
    next(error);
  }
};
