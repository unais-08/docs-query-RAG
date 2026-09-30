import { randomUUID } from 'node:crypto';
import { prisma } from '../../config/prisma.js';
import type { TextChunk } from '../../infrastructure/document-processing/chunking/text-chunker.js';
import { DocumentError } from './document.errors.js';
import { removeStoredFile } from './file.localdisk.storage.js';
import { deleteDocument as deleteSupabaseDocument } from '../../infrastructure/storage/supabase.storage.service.js';

// Keep API responses consistent and avoid exposing internal document fields.
const documentSummary = {
  id: true,
  name: true,
  fileType: true,
  fileSize: true,
  processingStatus: true,
  processingError: true,
  createdAt: true,
  updatedAt: true
} as const;

// Map database fields to the public API response format.
const toDocumentResponse = (document: {
  id: string;
  name: string;
  fileType: string;
  fileSize: number;
  processingStatus: string;
  processingError: string | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: document.id,
  name: document.name,
  type: document.fileType,
  size: document.fileSize,
  status: document.processingStatus,
  processingError: document.processingError,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt
});

export const createDocument = async (
  userId: string,
  file: Express.Multer.File,
  name?: string
) => {
  try {
    const document = await prisma.document.create({
      data: {
        userId,
        name: name ?? file.originalname,
        originalFileName: file.originalname,
        fileType: file.mimetype,
        fileSize: file.size,
        filePath: null,
        processingStatus: 'queued'
      },
      select: { ...documentSummary, originalFileName: true }
    });

    return {
      document: {
        ...toDocumentResponse(document),
        originalFileName: document.originalFileName
      }
    };
  } catch (error) {
    // Remove the uploaded file if its database record could not be created.
    await removeStoredFile(file.path);
    throw error;
  }
};

export const setDocumentStoragePath = async (documentId: string, storagePath: string) => {
  await prisma.document.update({
    where: { id: documentId },
    data: { storagePath }
  });
};

export const updateDocumentProcessing = async (
  documentId: string,
  processingStatus: 'queued' | 'processing' | 'ready' | 'failed',
  processingError: string | null = null
) => prisma.document.updateMany({
  where: { id: documentId },
  data: { processingStatus, processingError }
});

export const listDocuments = async (userId: string) => {
  const [documents, count] = await prisma.$transaction([
    prisma.document.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: documentSummary
    }),
    prisma.document.count({ where: { userId } })
  ]);

  return { documents: documents.map(toDocumentResponse), count };
};

export const getDocument = async (userId: string, id: string) => {
  // Scope the lookup by userId so users cannot access another user's document.
  const document = await prisma.document.findFirst({
    where: { id, userId },
    select: { ...documentSummary, originalFileName: true }
  });

  if (!document) {
    throw new DocumentError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
  }

  return {
    document: {
      ...toDocumentResponse(document),
      originalFileName: document.originalFileName
    }
  };
};

export const renameDocument = async (userId: string, id: string, name: string) => {
  const result = await prisma.document.updateMany({
    where: { id, userId },
    data: { name }
  });

  if (result.count === 0) {
    throw new DocumentError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
  }

  return getDocument(userId, id);
};

export const deleteDocument = async (userId: string, id: string) => {
  const document = await prisma.document.findFirst({ where: { id, userId } });

  if (!document) {
    throw new DocumentError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
  }

  if (document.storagePath) {
    await deleteSupabaseDocument(document.storagePath);
  }

  if (document.filePath) {
    await removeStoredFile(document.filePath);
  }

  await prisma.document.delete({ where: { id: document.id } });
};

export interface DocumentChunkRecord {
  id: string;
  documentId: string;
  userId: string;
  chunkIndex: number;
  text: string;
  pageNumber: number | null;
}

// Convert processed chunks into database-ready records with stable IDs.
export const buildDocumentChunkRecords = (
  documentId: string,
  userId: string,
  chunks: TextChunk[]
): DocumentChunkRecord[] => chunks.map((chunk) => ({
  id: randomUUID(),
  documentId,
  userId,
  chunkIndex: chunk.index,
  text: chunk.text,
  pageNumber: chunk.pageNumber ?? null
}));

export const createDocumentChunks = async (
  documentId: string,
  userId: string,
  chunks: TextChunk[]
) => {
  if (chunks.length === 0) {
    return [] as DocumentChunkRecord[];
  }

  const records = buildDocumentChunkRecords(documentId, userId, chunks);

  // Store chunk text and metadata in PostgreSQL; embeddings are stored in Supabase pgvector.
  await prisma.documentChunk.createMany({
    data: records.map(({ id, documentId, userId, chunkIndex, text, pageNumber }) => ({
      id,
      documentId,
      userId,
      chunkIndex,
      text,
      pageNumber
    }))
  });

  return records;
};

export const deleteDocumentChunks = async (documentId: string) => {
  await prisma.documentChunk.deleteMany({ where: { documentId } });
};

export const getDocumentStats = async (userId: string) => ({
  count: await prisma.document.count({ where: { userId } })
});
