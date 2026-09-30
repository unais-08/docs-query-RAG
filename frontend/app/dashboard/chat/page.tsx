"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { ChatComposer } from "@/components/dashboard/chat/chat-composer";
import { ChatDocumentToolbar } from "@/components/dashboard/chat/chat-document-toolbar";
import { ChatMessages } from "@/components/dashboard/chat/chat-messages";
import type { ChatMessage, DocSource, Feedback } from "@/components/dashboard/chat/chat-types";
import { useAuth } from "@/context/auth-context";
import {
    getDocuments,
    uploadDocument,
    validateDocumentFile,
    type Document,
} from "@/lib/api/documents";
import { queryDocuments } from "@/lib/api/query";
import {
    createConversation,
    getConversation,
    type PersistedChatMessage,
} from "@/lib/api/conversations";

function toDocSource(document: Document): DocSource {
    return {
        id: document.id,
        name: document.name,
        size: `${(document.size / (1024 * 1024)).toFixed(1)} MB`,
    };
}

function getErrorMessage(error: unknown, fallback: string) {
    return error instanceof Error && error.message ? error.message : fallback;
}

const CHAT_HEIGHT_CLASS = "h-[calc(100dvh-4rem)]";

export default function DocsChatPage() {
    const { token, loading: authLoading } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();

    // State
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [documents, setDocuments] = useState<DocSource[]>([]);
    const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
    const [documentsLoading, setDocumentsLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [conversationId, setConversationId] = useState<string | null>(null);
    const requestedConversationId = searchParams.get("conversationId");
    const conversationLoading = Boolean(requestedConversationId && conversationId !== requestedConversationId);

    const scrollRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    function toChatMessage(message: PersistedChatMessage): ChatMessage {
        return {
            id: message.id,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
            sources: message.sources ?? undefined,
            sourcesOpen: false,
            feedback: null,
        };
    }

    useEffect(() => {
        if (!token || authLoading) return;
        if (!requestedConversationId || requestedConversationId === conversationId) return;

        let cancelled = false;
        void getConversation(requestedConversationId, token)
            .then((response) => {
                if (!cancelled) {
                    setConversationId(requestedConversationId);
                    setMessages(response.messages.map(toChatMessage));
                    setSelectedDocumentIds(response.conversation.selectedDocumentIds);
                }
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    toast.error(getErrorMessage(error, "Failed to load conversation."));
                    router.replace("/dashboard/chat");
                }
            });

        return () => { cancelled = true; };
    }, [authLoading, conversationId, requestedConversationId, router, token]);

    // Data fetching and textarea behavior
    useEffect(() => {
        if (!token) return;

        let cancelled = false;
        const refreshDocuments = () => void getDocuments(token)
            .then((response) => {
                if (!cancelled) setDocuments(response.documents.filter((document) => document.status === "ready").map(toDocSource));
            })
            .catch((error: unknown) => {
                if (!cancelled) toast.error(getErrorMessage(error, "Failed to load documents."));
            })
            .finally(() => {
                if (!cancelled) setDocumentsLoading(false);
            });
        refreshDocuments();
        const poll = window.setInterval(refreshDocuments, 3000);

        return () => {
            cancelled = true;
            window.clearInterval(poll);
        };
    }, [token]);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }, [messages, isSending]);

    useEffect(() => {
        const element = textareaRef.current;
        if (!element) return;
        element.style.height = "auto";
        element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
    }, [input]);

    // Event handlers
    async function runQuery(query: string) {
        if (!query.trim() || documents.length === 0 || !token || isSending) return;
        if (selectedDocumentIds.length === 0) {
            toast.error("No documents selected. Please select at least one document to ask questions.");
            return;
        }

        const question = query.trim();
        const optimisticMessageId = `pending-${Date.now()}`;
        setInput("");
        setMessages((previous) => [
            ...previous,
            { id: optimisticMessageId, role: "user", content: question, createdAt: new Date().toISOString() },
        ]);
        setIsSending(true);

        try {
            let activeConversationId = conversationId;
            if (!activeConversationId) {
                const response = await createConversation(token);
                activeConversationId = response.conversation.id;
                setConversationId(activeConversationId);
                router.replace(`/dashboard/chat?conversationId=${activeConversationId}`);
            }

            const result = await queryDocuments({
                conversationId: activeConversationId,
                question,
                documentIds: selectedDocumentIds,
            }, token);
            setMessages((previous) => previous.map((message) => message.id === optimisticMessageId
                ? { id: result.messages.user.id, role: "user" as const, content: question, createdAt: result.messages.user.createdAt }
                : message
            ).concat({
                id: result.messages.assistant.id,
                role: "assistant",
                content: result.answer,
                createdAt: result.messages.assistant.createdAt,
                sources: result.sources,
                sourcesOpen: false,
                feedback: null,
            }));
        } catch (error: unknown) {
            setMessages((previous) => previous.filter((message) => message.id !== optimisticMessageId));
            toast.error(getErrorMessage(error, "Failed to get an answer."));
        } finally {
            setIsSending(false);
        }
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        void runQuery(input);
    }

    function handleRegenerate(assistantId: string) {
        const index = messages.findIndex((message) => message.id === assistantId);
        const lastUser = [...messages.slice(0, index)].reverse().find((message) => message.role === "user");
        if (!lastUser) return;
        setMessages((previous) => previous.filter((message) => message.id !== assistantId));
        void runQuery(lastUser.content);
    }

    function handleCopy(content: string) {
        navigator.clipboard?.writeText(content).catch(() => { });
    }

    function toggleSources(id: string) {
        setMessages((previous) =>
            previous.map((message) =>
                message.id === id ? { ...message, sourcesOpen: !message.sourcesOpen } : message,
            ),
        );
    }

    function setFeedback(id: string, value: Feedback) {
        setMessages((previous) =>
            previous.map((message) =>
                message.id === id
                    ? { ...message, feedback: message.feedback === value ? null : value }
                    : message,
            ),
        );
    }

    function toggleDocument(id: string) {
        setSelectedDocumentIds((previous) =>
            previous.includes(id) ? previous.filter((documentId) => documentId !== id) : [...previous, id],
        );
    }

    function selectAllDocuments() {
        setSelectedDocumentIds(documents.map((document) => document.id));
    }

    function clearDocumentSelection() {
        setSelectedDocumentIds([]);
    }

    async function handleFilesPicked(event: ChangeEvent<HTMLInputElement>) {
        const file = Array.from(event.target.files ?? [])[0];
        event.target.value = "";
        if (!file) return;

        const validationError = validateDocumentFile(file);
        if (validationError) {
            toast.error(validationError);
            return;
        }
        if (!token) {
            toast.error("Your session has expired. Please sign in again.");
            return;
        }

        setUploading(true);
        try {
            await uploadDocument(file, token);
            toast.success("Document queued. It will appear here when processing finishes.");
        } catch (error: unknown) {
            toast.error(getErrorMessage(error, "Failed to upload document."));
        } finally {
            setUploading(false);
        }
    }

    async function startNewChat() {
        setMessages([]);
        setConversationId(null);
        setSelectedDocumentIds([]);
        setInput("");
        router.push("/dashboard/chat");
    }

    return (
        <div className={`-my-4 sm:-my-6 lg:-my-8 flex ${CHAT_HEIGHT_CLASS} flex-col bg-background text-text-primary`}>
            <ChatDocumentToolbar
                documents={documents}
                selectedDocumentIds={selectedDocumentIds}
                authLoading={authLoading || conversationLoading}
                uploading={uploading}
                fileInputRef={fileInputRef}
                onToggleDocument={toggleDocument}
                onSelectAll={selectAllDocuments}
                onClearSelection={clearDocumentSelection}
                onFilesPicked={handleFilesPicked}
                onNewChat={startNewChat}
            />

            <ChatMessages
                messages={messages}
                isSending={isSending}
                scrollRef={scrollRef}
                onRegenerate={handleRegenerate}
                onCopy={handleCopy}
                onToggleSources={toggleSources}
                onFeedback={setFeedback}
            />

            <ChatComposer
                input={input}
                authLoading={authLoading}
                documentsLoading={documentsLoading || conversationLoading}
                hasDocuments={documents.length > 0}
                hasSelectedDocuments={selectedDocumentIds.length > 0}
                isSending={isSending}
                uploading={uploading}
                textareaRef={textareaRef}
                onInputChange={(event) => setInput(event.target.value)}
                onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void runQuery(input);
                    }
                }}
                onSubmit={handleSubmit}
                onAttach={() => fileInputRef.current?.click()}
            />
        </div>
    );
}
