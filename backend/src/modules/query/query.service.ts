import { logger } from "../../config/logger.js";
import { prisma } from "../../config/prisma.js";
import { generateEmbedding } from "../../infrastructure/document-processing/embeddings/generate-embeddings.js";
import { generateAnswer } from "../../infrastructure/llm/generate.answer.js";
import {
    searchSimilarChunks,
    type SimilarChunkResult,
} from "../../infrastructure/vector-store/supabase.vector.service.js";
import { buildContext } from "./context-builder.js";
import { assertConversationOwnership } from "../conversations/conversation.service.js";
import { DocumentError } from "../documents/document.errors.js";

export interface RetrievedChunk {
    chunkId: string;
    documentId: string;
    documentName: string;
    text: string;
    chunkIndex: number;
    pageNumber: number | null;
    score: number;
}

type DocumentChunkRow = {
    id: string;
    documentId: string;
    text: string;
    chunkIndex: number;
    pageNumber: number | null;
    document: {
        name: string;
    };
};

export const getChunksForQueryResults = async (
    results: SimilarChunkResult[],
    userId: string
): Promise<RetrievedChunk[]> => {
    if (results.length === 0) {
        return [];
    }

    // Supabase returns the most similar chunk IDs; fetch the actual text and metadata from Postgres.
    const chunks = (await prisma.documentChunk.findMany({
        where: {
            id: { in: results.map((result) => result.chunkId) },
            document: { userId },
        },
        select: {
            id: true,
            documentId: true,
            text: true,
            chunkIndex: true,
            pageNumber: true,
            document: {
                select: {
                    name: true,
                },
            },
        },
    })) as DocumentChunkRow[];

    const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));

    return results.flatMap((result) => {
        const chunk = chunksById.get(result.chunkId);

        if (!chunk) {
            return [];
        }

        return [{
            chunkId: chunk.id,
            documentId: chunk.documentId,
            documentName: chunk.document.name,
            text: chunk.text,
            chunkIndex: chunk.chunkIndex,
            pageNumber: chunk.pageNumber,
            score: result.score,
        }];
    });
};

export const queryDocuments = async (
    conversationId: string,
    question: string,
    documentIds: string[],
    userId: string
) => {
    await assertConversationOwnership(userId, conversationId);
    const ownedDocumentCount = await prisma.document.count({
        where: { id: { in: documentIds }, userId, processingStatus: 'ready' },
    });
    if (ownedDocumentCount !== documentIds.length) {
        throw new DocumentError("One or more selected documents are still processing or unavailable", 409, "DOCUMENT_NOT_READY");
    }

    await prisma.conversation.updateMany({
        where: { id: conversationId, userId },
        data: { selectedDocumentIds: documentIds },
    });

    const userMessage = await prisma.chatMessage.create({
        data: { conversationId, role: "user", content: question }
    });

    const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId },
        select: { title: true, messages: { select: { id: true } } }
    });
    const questionEmbedding = await generateEmbedding(question);

    logger.debug(`now goes to searchSimilarChunks with embedding of length ${questionEmbedding.length} for userId: ${userId}`);
    // The vector RPC filtering and the Postgres ownership check both enforce user isolation.
    const results = await searchSimilarChunks(questionEmbedding, userId, documentIds);
    const retrievedChunks = await getChunksForQueryResults(results, userId);
    const context = buildContext(retrievedChunks);
    const answer = await generateAnswer(question, context);
    const sources = retrievedChunks.map(({ chunkId, documentId, documentName, pageNumber, score }) => ({
        chunkId,
        documentId,
        documentName,
        pageNumber,
        score,
    }));

    const assistantMessage = await prisma.chatMessage.create({
        data: { conversationId, role: "assistant", content: answer, sources }
    });
    await prisma.conversation.updateMany({
        where: { id: conversationId, userId },
        data: { updatedAt: new Date() }
    });

    if (conversation?.title === "New Chat" && conversation.messages.length === 1) {
        await prisma.conversation.updateMany({
            where: { id: conversationId, userId },
            data: { title: question.slice(0, 120) }
        });
    }

    return {
        question,
        answer,
        sources,
        messages: { user: userMessage, assistant: assistantMessage },
        // results: retrievedChunks,
    };
};
