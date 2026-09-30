import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { logger } from '../../config/logger.js';
import { DocumentError } from '../../modules/documents/document.errors.js';

import { bucketName, supabase } from './supabase.client.js';
import { getStoragePath } from './supabase.helper.js';
import { env } from '../../config/env.js';


export const uploadDocument = async (
  filePath: string,
  userId: string,
  documentId: string,
  originalFileName: string,
  contentType: string
): Promise<string> => {
  const storagePath = getStoragePath(userId, documentId, originalFileName);

  try {
    const fileBuffer = await readFile(filePath);

    // Cross-version SDK Safety: Convert Buffer to a standard Blob payload
    const fileBlob = new Blob([fileBuffer], { type: contentType });

    const { error } = await supabase.storage
      .from(bucketName)
      .upload(storagePath, fileBlob, {
        contentType,
        upsert: false
      });

    if (error) {
      // Log the concrete Supabase internal issue for backend monitoring
      logger.error(`Supabase upload internal exception: ${error}`);
      throw error;
    }
    logger.debug('Document uploaded successfully to Supabase storage');
    return storagePath;
  } catch (error) {
    throw new DocumentError('Document storage upload failed', 502, 'STORAGE_UPLOAD_FAILED');
  }
};

export const deleteDocument = async (storagePath: string): Promise<void> => {
  try {
    const { error } = await supabase.storage.from(bucketName).remove([storagePath]);

    if (error) {
      console.error('Supabase removal internal exception:', error);
      throw error;
    }
  } catch (error) {
    throw new DocumentError('Document storage cleanup failed', 502, 'STORAGE_DELETE_FAILED');
  }
};

export const downloadDocumentToTempFile = async (storagePath: string, extension: string): Promise<string> => {
  const { data, error } = await supabase.storage.from(bucketName).download(storagePath);
  if (error || !data) {
    logger.error({ err: error, storagePath }, 'Document download from storage failed');
    throw new DocumentError('Document download failed', 502, 'STORAGE_DOWNLOAD_FAILED');
  }

  const safeExtension = /^\.[a-z0-9]+$/i.test(extension) ? extension : '.bin';
  const directory = path.resolve(env.UPLOAD_DIR);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${randomUUID()}${safeExtension}`);
  await writeFile(filePath, Buffer.from(await data.arrayBuffer()), { flag: 'wx' });
  return filePath;
};
